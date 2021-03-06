const cacheManager = require('cache-manager');
const get = require('get-property-value');
const fetch = require('node-fetch');

const {encodeQueryString, replaceVars, getCacheId} = require('./utils');
const Block = require('./block');

const env = process.env || {};
const API_URL = env.WURD_API_URL || 'https://api-v3.wurd.io';


class Wurd {

  constructor() {
    this.app = null;

    this.options = {
      draft: false,
      editMode: false,
      lang: null,
      log: false
    };

    this.cache = cacheManager.caching({ store: 'memory', max: 100, ttl: 60 });
  }

  /**
   * Sets up the default connection/instance
   *
   * @param {String} app                          The app name
   * @param {Object} [options]
   * @param {Boolean} [options.draft]             If true, loads draft content; otherwise loads published content
   * @param {Boolean|String} [options.editMode]   Options for enabling edit mode: `true` or `'querystring'`
   *
   * @return {Function} middleware
   */
  connect(app, options = {}) {
    this.app = app;
    
    Object.assign(this.options, options);

    if (this.options.editMode === true) {
      this.options.draft = true;
    }

    //Return express middleware that detects request-specific options such as editMode and language
    return (req, res, next) => {
      let query = req.query || {};

      req.wurd = {};

      if (options.editMode === 'querystring') {
        req.wurd.editMode = (typeof query.edit !== 'undefined');
      }

      if (options.langMode === 'querystring' && query.lang) {
        req.wurd.lang = query.lang;
      }

      //Force draft to true if editMode is on
      if (req.wurd.editMode) req.wurd.draft = true;

      next();
    };
  }

  /**
   * Loads a section of content so that it's items are ready to be accessed with #get(id)
   *
   * @param {String|Array} ids      IDs of sections to load content for. Can be an array or comma-separated string of sections to load, e.g. 'main,home'
   * @param {Object} [options]      Options to override the instance defaults.
   * 
   * @return {Promise}
   */
  load(ids, options = {}) {
    //Merge default and request options
    options = Object.assign({}, this.options, options);

    //Force draft to true if in editMode
    if (options.editMode === true) {
      options.draft = true;
    }

    return new Promise((resolve, reject) => {

      let {app} = this;

      if (!app) return reject(new Error('Use wurd.connect(appName) before wurd.load()'));

      //Normalise ids to array
      if (typeof ids === 'string') ids = ids.split(',');

      options.log && console.log('loading: ', ids, options);

      //If in draft, skip cache
      if (options.draft) {
        return this._loadFromServer(ids, options)
          .then(content => {
            resolve(new Block(app, null, content, options));
          })
          .catch(reject);
      }

      //Otherwise not in draft mode; check for cached versions
      this._loadFromCache(ids, options)
        .then(cachedContent => {
          let uncachedIds = Object.keys(cachedContent).filter(id => {
            return cachedContent[id] === undefined;
          });

          //If all content was cached, return it without a server trip
          if (!uncachedIds.length) {
            return cachedContent;
          }

          return this._loadFromServer(uncachedIds, options)
            .then(fetchedContent => {
              this._saveToCache(fetchedContent, options);

              return Object.assign(cachedContent, fetchedContent);
            });
        })
        .then(allContent => {
          resolve(new Block(app, null, allContent, options));
        })
        .catch(err => reject(err));

    });
  }

  /**
   * Express middleware that loads section content and makes it available to templates with helpers (get, map, etc.).
   *
   * @param {String|Array} ids      IDs of sections to load content for. Can be an array or comma-separated string of sections to load, e.g. 'main,home'
   * 
   * @return {Function} middleware
   */
  mw(ids) {
    return (req, res, next) => {
      let options = req.wurd;

      this.load(ids, options).then(content => {
        res.locals.wurd = content;

        next();
      })
      .catch(next);
    };
  }

  /**
   * @param {Object} allContent    Content keyed by section ID (i.e. the response from the Wurd content API)
   *
   * @return {Promise}
   */
  _saveToCache(allContent, options = {}) {
    let promises = Object.keys(allContent).map(id => {
      let sectionContent = allContent[id];

      return this.cache.set(getCacheId(id, options), sectionContent);
    });

    return Promise.all(promises);
  }

  /**
   * @param {Array} ids           Section IDs to load content for
   *
   * @return {Promise}
   */
  _loadFromCache(ids, options = {}) {
    let allContent = {};

    let promises = ids.map(id => {
      return this.cache.get(getCacheId(id, options)).then(sectionContent => {
        allContent[id] = sectionContent
      });
    });

    return Promise.all(promises).then(() => {
      return allContent;
    });
  }

  /**
   * @param {Array} ids           Section IDs to load content for
   *
   * @return {Promise}
   */
  _loadFromServer(ids, options) {
    const {app} = this;

    const sections = ids.join(',');
    const params = {};
      
    if (options.draft) params.draft = 1;
    if (options.lang) params.lang = options.lang;
    
    const url = `${API_URL}/apps/${app}/content/${sections}?${encodeQueryString(params)}`;
    
    options.log && console.info('from server: ', ids);

    return this._fetch(url);
  }

  _fetch(url) {
    return fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`Error loading ${url}: ${res.statusText}`);

        return res.json();
      });
  }

};



let instance = new Wurd();

instance.Wurd = Wurd;


module.exports = instance;
