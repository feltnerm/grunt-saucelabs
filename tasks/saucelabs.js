/* jshint laxcomma: true */
module.exports = function(grunt) {
  var _ = (grunt.utils || grunt.util)._,
    request = require('request'),
    wd = require('wd'),
    SauceTunnel = require('sauce-tunnel'),
    rqst = request.defaults({
      jar: false
    });

  var SauceStatus = function(user, key) {
    this.user = user;
    this.key = key;
    this.baseUrl = ["https://", this.user, ':', this.key, '@saucelabs.com', '/rest/v1/', this.user].join("");
  };

  SauceStatus.prototype.passed = function(jobid, status, callback) {
    var _body = JSON.stringify({
      "passed": status
    }),
      _url = this.baseUrl + "/jobs/" + jobid;
    rqst({
      headers: {
        'content-type': 'application/x-www-form-urlencoded'
      },
      method: "PUT",
      url: _url,
      body: _body,
      json: true
    }, function() {
      callback();
    });
  };

  SauceStatus.prototype.result = function(jobid, data, callback) {
    var _body = JSON.stringify(data),
        _url = this.baseUrl + "/jobs/" + jobid;
    rqst({
      headers: {
        'content-type': 'application/json'
      },
      method: "PUT",
      url: _url,
      body: _body,
      json: true
    }, function() {
      callback();
    });
  };

  var TestRunner = function(user, key) {
    this.user = user;
    this.key = key;
    this.host = 'ondemand.saucelabs.com';
    this.port = 80;
    this.report = new SauceStatus(user, key);
  };

  TestRunner.prototype.forEachBrowser = function(configs, runner, saucify, concurrency, onTestComplete) {
    var me = this;
    return {
      testPages: function(pages, testTimeout, testInterval, testReadyTimeout, detailedError, callback) {
        function initBrowser(cfg) {
          var success = true;
          var results = {};

          function onPageTested(status, page, config, browser, cb) {
            var waitForAsync = false;
            this.async = function() {
              waitForAsync = true;
              return function(ret) {
                success = success && (typeof ret === "undefined" ? status : ret);
                cb();
              };
            };
            if (typeof onTestComplete === "function") {
              var ret = onTestComplete(status, page, config, browser);
              status = typeof ret === "undefined" ? status : ret;
            }
            if (!waitForAsync) {
              success = success && status;
              cb();
            }
          }

          return function(done) {
            var driver = wd.remote(me.host, me.port, me.user, me.key);
            grunt.verbose.writeln("Starting tests on browser configuration", cfg);
            driver.init(cfg, function(err, sessionId) {
              if (err) {
                grunt.log.error("[%s] Could not initialize browser for session", cfg.prefix, sessionId, cfg);
                success = false;
                me.report.passed(driver.sessionID, success, function() {
                  done(success);
                });
                return;
              }
              var finished = function(cb) {
                if (results && typeof saucify === 'function') {
                  me.report.result(driver.sessionID, saucify(results), function() {
                    cb(success);
                  });
                } else {
                  cb(success);
                }
              };
              (function testPage(j) {
                if (j >= pages.length) {
                  driver.quit(function() {
                    me.report.passed(driver.sessionID, success, function() {
                      finished(done);
                    });
                  });
                  return;
                }
                grunt.verbose.writeln("[%s] Testing page#%s %s at http://saucelabs.com/tests/%s", cfg.prefix, j, pages[j], driver.sessionID);
                driver.get(pages[j], function(err) {
                  if (err) {
                    grunt.log.error("[%s] Could not fetch page (%s)%s", cfg.prefix, j, pages[j]);
                    onPageTested(false, pages[j], cfg, driver, function() {
                      testPage(j + 1);
                    });
                    return;
                  }
                  driver.page = pages[j];
                  runner.call(me, driver, cfg, testTimeout, testInterval, testReadyTimeout, detailedError, function(status, obj) {
                    results = obj;
                    onPageTested(status, pages[j], cfg, driver, function() {
                      testPage(j + 1);
                    });
                  });
                });
              }(0));
            });
          };
        }

        var brwrs = [],
          colors = ['yellow', 'cyan', 'magenta', 'blue', 'green', 'red'],
          curr = 0,
          running = 0,
          res = true;
        _.each(configs, function(_c, i) {
          _c.prefix = _c.name || (_c.platform ? _c.platform + '::' : '') + _c.browserName + (_c.version ? '(' + _c.version + ')' : '');
          _c.prefix = _c.prefix[colors[i % colors.length]];
          brwrs.push(initBrowser(_c));
        });

        (function next(success) {
          if (typeof success !== 'undefined') {
            res = res && success;
            running--;
          }

          if (curr >= brwrs.length && running <= 0) {
            return callback(res);
          }

          if (running < concurrency && curr < brwrs.length) {
            brwrs[curr](next);
            curr++;
            running++;
            next();
          }
        }());
      }
    };
  };

  TestRunner.prototype.mochaSaucify = function(results) {
    var out = {'custom-data': { mocha: {} }};
    out['custom-data'].mocha = results;
    return out;
  };

  TestRunner.prototype.mochaRunner = function(driver, cfg, testTimeout, testInterval, testReadyTimeout, detailedError, callback) {

      var fetchResults = function(cb, status, result) {
        cb(status, result);
      };

      /*
      * Evaluate the mocha.results object which should hold the "Sauce Special Format"
      * object which can then be viewing nicely on the Saucelabs site.
      */
      var parseResults = function () {
        driver.safeEval("JSON.stringify(window.mochaResults)", function(err, results) {
          if (err) {
            grunt.log.error('Error - Could not check if tests are completed: %s', err);
            callback(false);
            return;
          }

          var res = JSON.parse(results);
          grunt.log.subhead('\nTested %s', driver.page);
          grunt.log.writeln("Environment: %s", cfg.prefix);
          grunt.log.writeln("Browser: %s", cfg.browserName);
          grunt.log.writeln("Version: %s", cfg.version);
          grunt.log.writeln("Platform: %s", cfg.platform);

          grunt.log.subhead("Stats");
          grunt.log.writeln("Start: %s", res.start.toString());
          grunt.log.writeln("End: %s", res.end.toString());
          grunt.log.writeln("Duration: %s", res.duration);
          grunt.log.writeln("Passes: %s", res.passes);
          grunt.log.writeln("Failures: %s", res.failures);
          grunt.log.writeln("Pending: %s", res.pending);
          grunt.log.writeln("Tests: %s", res.tests);

          fetchResults(callback, res.failures === 0, res.jsonReport);

          grunt.log.writeln("Test Video: http://saucelabs.com/tests/%s", driver.sessionID);
        });
      };

    grunt.verbose.writeln("[%s] Starting mocha tests for page", cfg.prefix);
    driver.waitForCondition("window.chocoReady", testReadyTimeout, testInterval, function (err) {
      if (err) {
        grunt.log.debug("[%s] Unable to find `mocha.chocoReady` object.", cfg.prefix);
        callback(false);
        return;
      } else {
        parseResults();
      }
  });
};

  /*
  * The stock options
  */
  var defaultsObj = {
    username: process.env.SAUCE_USERNAME,
    key: process.env.SAUCE_ACCESS_KEY,
    identifier: Math.floor((new Date()).getTime() / 1000 - 1230768000).toString(),
    tunneled: true,
    testTimeout: (1000 * 60 * 5),
    tunnelTimeout: 120,
    testInterval: 1000 * 5,
    testReadyTimeout: (1000 * 5),
    onTestComplete: function() {

    },
    detailedError: false,
    testname: "",
    tags: [],
    browsers: [{}]
  };

  /*
  * Function which applies the combines the default settings with
  * the options provided by the user in the grunt task defintion.
  */
  function defaults(data) {
    var result = data;
    result.pages = result.url || result.urls;
    if (!_.isArray(result.pages)) {
      result.pages = [result.pages];
    }

    _.map(result.browsers, function(d) {
      return _.extend(d, {
        'name': result.testname,
        'tags': result.tags,
        'build': result.build,
        'tunnel-identifier': result.tunneled ? result.identifier : ''
      });
    });
    result.concurrency = result.concurrency || result.browsers.length;
    return result;
  }

  function configureLogEvents(tunnel) {
    var methods = ['write', 'writeln', 'error', 'ok', 'debug'];
    methods.forEach(function (method) {
      tunnel.on('log:'+method, function (text) {
        grunt.log[method](text);
      });
      tunnel.on('verbose:'+method, function (text) {
        grunt.verbose[method](text);
      });
    });
  }

  /*
  * The grunt task for running Mocha tests on Saucelabs
  */
  grunt.registerMultiTask('saucelabs-mocha', 'Run Mocha test cases using Sauce Labs browsers', function() {
    var done = this.async(),
        arg = defaults(this.options(defaultsObj));
    var tunnel = new SauceTunnel(arg.username, arg.key, arg.identifier, arg.tunneled, arg.tunnelTimeout);
    configureLogEvents(tunnel);
    grunt.log.writeln("=> Connecting to Saucelabs ...");

    if (this.tunneled) {
      grunt.verbose.writeln("=> Starting Tunnel to Sauce Labs".inverse.bold);
    }

    tunnel.start(function(isCreated) {
      if (!isCreated) {
        done(false);
        return;
      }
      grunt.log.ok("Connected to Saucelabs");

      var test = new TestRunner(arg.username, arg.key);
      test.forEachBrowser(arg.browsers, test.mochaRunner, test.mochaSaucify, arg.concurrency, arg.onTestComplete).testPages(arg.pages, arg.testTimeout, arg.testInterval, arg.testReadyTimeout, arg.detailedError, function(status) {
        grunt.log[status ? 'ok' : 'error']("All tests completed with status %s", status);
        tunnel.stop(function() {
          done(status);
        });
      });
    });
  });
};
