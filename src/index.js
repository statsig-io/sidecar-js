const StatsigClient = require('statsig-js').StatsigClient;
const StatsigWA = require('statsig-web-analytics');

window["StatsigSidecar"] = window["StatsigSidecar"] || {
  _statsigInstance: null,
  _queuedEvents: [],
  _clientInitialized: false,

  getStatsigInstance: function() {
    return this._statsigInstance;
  },

  _getMatchingExperiments: function() {
    const scConfig = this._statsigInstance.getConfig('sidecar_dynamic_config');
    if (!scConfig) {
      return null;
    }
    const exps = scConfig.getValue('activeExperiments', []);
    const matchingExps = [];
    let url = window.location.href;
    try {
      const u = new URL(url);
      u.searchParams.delete('overrideuser');
      url = u.toString();
    } catch (e) {
    }
    exps.forEach((exp) => {
      const filters = exp.filters || [];
      const filterType = exp.filterType || 'all';

      if (this._isMatchingExperiment(url, filterType, filters)) {
        matchingExps.push(exp.id);
      }
    });
    return matchingExps;
  },

  _isMatchingExperiment: function(url, filterType, filters) {
    if (filterType === 'all' || filters.length === 0) {
      return true;
    }    
    if (filterType === 'contains') {
      return filters.some((filter) => url.includes(filter));
    } else if (filterType === 'equals') {
      return filters.some((filter) => url === filter);
    } else if (filterType === 'regex') {
      return filters.some((filter) => RegExp(filter).test(url));
    }
    return false;
  },

  _flushQueuedEvents: function() {
    if (this._queuedEvents.length === 0) {
      return;
    }
    if (!this._statsigInstance) {
      return;
    }

    const events = [...this._queuedEvents];
    this._queuedEvents = [];
    events.forEach((event) => {
      this._statsigInstance.logEvent(
        event.eventName,
        event.value,
        event.metadata
      );
    });
    this._statsigInstance.flushEvents();
  },

  logEvent: function(eventName, value, metadata) {
    if (!this._statsigInstance || !this._clientInitialized) {
      this._queuedEvents.push({ eventName, value, metadata });
      return;
    }

    this._flushQueuedEvents();
    this._statsigInstance.logEvent(eventName, value, metadata);
  },

  performContentChange: function(query, value) {
    if (!query) {
      return;
    }
    const element = document.querySelector(query);
    if (element) {
      element.innerHTML = value;
    }
  },

  performReorderElement: function(query, operator, anchorQuery) {
    if (!query) {
      return;
    }
    const target = document.querySelector(query);
    const anchor = document.querySelector(anchorQuery);
    if (!target || !anchor) {
      return;
    }

    switch (operator) {
      case 'before':
        anchor.before(target);
        break;
      case 'after':
        anchor.after(target);
        break;
      case 'first':
        anchor.prepend(target);
        break;
      case 'last':
        anchor.append(target);
        break;
    }
  },

  performStyleChange: function(query, value) {
    if (!query) {
      return;
    }
    const element = document.querySelector(query);
    if (element) {
      element.setAttribute('style', value);
    }
  },

  performAttributeChange: function(query, attribute, value) {
    if (!query) {
      return;
    }
    const element = document.querySelector(query);
    if (element) {
      element.setAttribute(attribute, value);
    }
  },

  performInjectScript: function(value, nonce) {
    const script = document.createElement('script');
    script.setAttribute('nonce', nonce);
    script.nonce = nonce;
    script.innerHTML = value;
    document.head.appendChild(script);
  },

  performInjectStyle: function(value) {
    const style = document.createElement('style');
    style.innerHTML = value;
    document.head.appendChild(style);
  },

  _performDirective: function(directive, nonce) {
    switch (directive.actionType) {
      case 'content-change':
        this.performContentChange(directive.queryPath, directive.value);
        break;

      case 'style-change':
        this.performStyleChange(directive.queryPath, directive.value);
        break;
      
      case 'image-change':
        this.performAttributeChange(directive.queryPath, 'src', directive.value);
        break;

      case 'reorder-element':
        this.performReorderElement(
          directive.queryPath,
          directive.operator,
          directive.anchorQueryPath,
        );
        break;

      case 'inject-script':
        this.performInjectScript(directive.value, nonce);
        break;

      case 'inject-style':
        this.performInjectStyle(directive.value);
        break;
    }
  },

  _performExperiments: function(expIds, nonce) {
    if (Array.isArray(expIds)) {
      expIds.forEach((expId) => {
        const expConfig = this._statsigInstance.getExperiment(expId);
        const directives = expConfig.get('directives', []);
        directives.forEach((directive) => {
          this._performDirective(directive, nonce);
        });
      });
    }
  },

  resetBody: function() {
    const sbpd = document.getElementById('__sbpd');
    if (sbpd) {
      sbpd.parentElement.removeChild(sbpd);
    }
  },

  setupStatsigSdk: async function(apiKey, expIds, autoStart, nonce) {
    let overrideUser = null;
    try {
      const url = new URL(window.location.href);
      overrideUser = url.searchParams.get('overrideuser');
    } catch (e) {
      console.error('Failed to update user:', e);
    }

    try {
      if (overrideUser) {
        this._statsigInstance  = new StatsigClient(
          apiKey, 
          {
            userID: overrideUser,
            customIDs: {
              stableID: overrideUser,
            },
          },
          { overrideStableID: overrideUser },
        );
        await this._statsigInstance.initializeAsync();
      } 
      
      if (!this._statsigInstance) {
        await StatsigWA.initialize(apiKey, autoStart);
        this._statsigInstance = StatsigWA.getStatsigClient();
      }

      this._clientInitialized = true;
      this._flushQueuedEvents();

      if (!expIds) {
        expIds = this._getMatchingExperiments();
      }
      if (expIds) {
        this._performExperiments(expIds, nonce);
      }
    } catch (e) {
      console.error('Failed to initialize Statsig:', e);
    }
    this.resetBody();
    if (window?.postExperimentCallback) {
      window.postExperimentCallback(this._statsigInstance, expIds);
    }
  },
}

if (document.currentScript && document.currentScript.src) {
  const url = new URL(document.currentScript.src);
  const apiKey = url.searchParams.get('apikey');
  const multiExpIds = url.searchParams.get('multiexpids');
  const autoStart = url.searchParams.get('autostart') !== '0';
  if (apiKey) {
    document.write('<style id="__sbpd">body { display: none; }</style>\n');
    const expIds = multiExpIds ? multiExpIds.split(',') : null;
    StatsigSidecar.setupStatsigSdk(
      apiKey,
      expIds,
      autoStart,
      document.currentScript.nonce,      
    );
  }
}

window.addEventListener('sidecar::run', function(ext) {
  try {
    eval(ext.detail);
  } catch(err) {
    console.error('Failed to run JS from Sidecar extension', err);
  }
});
