import { StatsigClient } from "@statsig/js-client";
import { runStatsigSessionReplay } from '@statsig/session-replay';
import { runStatsigAutoCapture } from '@statsig/web-analytics';

window["StatsigSidecar"] = window["StatsigSidecar"] || {
  _statsigInstance: null,
  _queuedEvents: [],
  _clientInitialized: false,

  getStatsigInstance: function() {
    return this._statsigInstance;
  },

  _getMatchingExperiments: function() {
    const scConfig = this._statsigInstance.getDynamicConfig(
      'sidecar_dynamic_config',
    );
    if (!scConfig) {
      return null;
    }
    const exps = scConfig.get('activeExperiments', []);
    const matchingExps = [];
    let url = window.location.href;
    try {
      const u = new URL(url);
      // This check is important or else it messes up the original URL
      if (u.searchParams.has('overrideuser')) {
        u.searchParams.delete('overrideuser');
      }
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
    } else if (filterType === 'path') {
      const path = new URL(url).pathname;
      return filters.some((filter) => path === filter);
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

  _isIOS: function() {
    return /iPad|iPhone|iPod/.test(navigator?.userAgent ?? '');
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
      this.observeMutation(element, () => {
        if (element.innerHTML !== value) {
          element.innerHTML = value;
        }
      });
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
      const existingStyle = element.getAttribute('style') || '';
      const newStyle = `${existingStyle}; ${value}`;
      this.observeMutation(element, () => {
        if (element.getAttribute('style') !== newStyle) {
          element.setAttribute('style', newStyle);
        }
      });
    }
  },

  performAttributeChange: function(query, attribute, value, removeAttrs = []) {
    if (!query) {
      return;
    }
    const element = document.querySelector(query);
    if (element) {
      this.observeMutation(element, () => {
        if (element.getAttribute(attribute) !== value) {
          element.setAttribute(attribute, value);
          removeAttrs?.forEach((attr) => {
            element.removeAttribute(attr);
          });
        }
      });
    }
  },

  performInjectScript: function(value) {
    const script = document.createElement('script');
    script.setAttribute('nonce', this.scriptNonce);
    script.nonce = this.scriptNonce;
    script.innerHTML = value;
    document.head.appendChild(script);
  },

  performInjectStyle: function(value) {
    const style = document.createElement('style');
    style.innerHTML = value;
    document.head.appendChild(style);
  },

  _performDirective: function(directive) {
    switch (directive.actionType) {
      case 'content-change':
        this._performAfterLoad(() => {
          this.performContentChange(directive.queryPath, directive.value);
        });
        break;

      case 'style-change':
        this._performAfterLoad(() => {
          this.performStyleChange(directive.queryPath, directive.value);
        });
        break;

      case 'image-change':
        this._performAfterLoad(() => {
          this.performAttributeChange(
            directive.queryPath,
            'src',
            directive.value,
            ['srcset'],
          );
        });
        break;

      case 'reorder-element':
        this._performAfterLoad(() => {
          this.performReorderElement(
            directive.queryPath,
            directive.operator,
            directive.anchorQueryPath,
          );
        });
        break;

      case 'inject-script':
        this.performInjectScript(directive.value);
        break;

      case 'inject-style':
        this.performInjectStyle(directive.value);
        break;

      case 'redirect-page':
        this.redirectPage(directive.value);
        break;
    }
  },

  _performAfterLoad: function(callback) {
    if (/complete|interactive|loaded/.test(document.readyState)) {
      callback();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        callback();
      });
    }
  },

  _performExperiments: function(expIds) {
    if (Array.isArray(expIds)) {
      expIds.forEach((expId) => {
        const expConfig = this._statsigInstance.getExperiment(expId);
        const directives = expConfig.get('directives', []);
        directives.forEach((directive) => {
          try {
            this._performDirective(directive);
          } catch (e) {
            console.error('Failed to perform directive:', e);
          }
        });
      });
    }
  },

  processEvent: function(event) {
    if (!event || !event.detail) {
      return false;
    }

    const detail = event.detail;
    if (detail.name === 'inject-script') {
      this.performInjectScript(detail.value);
      return false;
    }
  },

  observeMutation: function(element, modifierFunc) {
    const config = { attributes: true, childList: true };
    const callback = (mutationsList, observer) => {
      setTimeout(() => {
        modifierFunc();
      }, 0);
    };
    const observer = new MutationObserver(callback);
    observer.observe(element, config);
    modifierFunc();
  },

  redirectPage: async function(url) {
    this._flushQueuedEvents();

    if (!window || !window.location || !url || window.location.href == url) {
      return;
    }

    try {
      const currentUrl = new URL(window.location.href);
      const newUrl = new URL(url, currentUrl);
      for (const key of currentUrl.searchParams.keys()) {
        if (!newUrl.searchParams.has(key)) {
          newUrl.searchParams.set(key, currentUrl.searchParams.get(key));
        }
      }

      if (this._isIOS()) {
        await this._statsigInstance.flush();
      }

      window.location.href = newUrl.toString();
    } catch (e) {
      window.location.href = url;
    }
  },

  resetBody: function() {
    const sbpd = document.getElementById('__sbpd');
    if (sbpd) {
      sbpd.parentElement.removeChild(sbpd);
    }
  },

  setupStatsigSdk: async function(
    apiKey,
    expIds,
    autoStart,
    initUrlOverride,
    logUrlOverride,
  ) {
    let overrideUserID = null;
    try {
      const url = new URL(window.location.href);
      overrideUserID = url.searchParams.get('overrideuser');
    } catch (e) {
      console.error('Failed to update user:', e);
    }

    try {
      const user = window?.statsigUser ?? (
        overrideUserID ? {
            userID: overrideUserID,
            customIDs: { stableID: overrideUserID }
          }
          : {}
      );
      const options = window?.statsigOptions ?? {};
      options.disableLogging = !autoStart;
      if (initUrlOverride || logUrlOverride) {
        options.networkConfig = {
          initializeUrl: initUrlOverride,
          logEventUrl: logUrlOverride,
        };
      }
      this._statsigInstance  = new StatsigClient(apiKey, user, options);
      await this._statsigInstance.initializeAsync();
      runStatsigAutoCapture(this._statsigInstance);

      if (window?.runStatsigSessionReplay) {
        if (window?.statsigSessionReplayOptions) {
          runStatsigSessionReplay(this._statsigInstance, sessionReplayOptions);
        }
        else {
          runStatsigSessionReplay(this._statsigInstance);
        }
      }

      this._clientInitialized = true;
      this._flushQueuedEvents();

      if (!expIds) {
        expIds = this._getMatchingExperiments();
      }
      if (expIds) {
        this._performExperiments(expIds);
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
  const initUrl = url.searchParams.get('initializeurl');
  const logUrl = url.searchParams.get('logeventurl');

  const autoStart = url.searchParams.get('autostart') !== '0';
  // Deprecated
  // const autoCapture = url.searchParams.get('autocapture') !== '0';
  const reduceFlicker = url.searchParams.get('reduceflicker') !== '0';
  StatsigSidecar.scriptNonce = document.currentScript.nonce;
  if (apiKey) {
    if (reduceFlicker) {
      document.write('<style id="__sbpd">body { display: none; }</style>\n');
      setTimeout(() => {
        StatsigSidecar.resetBody();
      }, 1000);
    }
    const expIds = multiExpIds ? multiExpIds.split(',') : null;
    StatsigSidecar.setupStatsigSdk(
      apiKey,
      expIds,
      autoStart,
      initUrl,
      logUrl,
    );
    document.addEventListener(`sidecar_${apiKey}`, (e) => {
      StatsigSidecar.processEvent(e);
      e.preventDefault();
    });
  }
}
