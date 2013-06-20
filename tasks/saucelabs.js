/* jshint laxcomma: true */
module.exports = function(grunt) {
  var _ = (grunt.utils || grunt.util)._
    , request = require('request')
    , proc = require('child_process')
    , wd = require('wd')
    , rqst = request.defaults({
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
    var _body = JSON.stringify(data)
      , _url = this.baseUrl + "/jobs/" + jobid;
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

  var SauceTunnel = function(user, key, identifier, tunneled, tunnelTimeout) {
    this.user = user;
    this.key = key;
    this.identifier = identifier;
    this.tunneled = tunneled;
    this.tunnelTimeout = tunnelTimeout;
    this.baseUrl = ["https://", this.user, ':', this.key, '@saucelabs.com', '/rest/v1/', this.user].join("");
  };

  SauceTunnel.prototype.openTunnel = function(callback) {
    var args = ["-jar", __dirname + "/Sauce-Connect.jar", this.user, this.key, "-i", this.identifier];
    this.proc = proc.spawn('java', args);
    var calledBack = false;

    this.proc.stdout.on('data', function(d) {
      var data = typeof d !== 'undefined' ? d.toString() : '';
      if (typeof data === 'string' && !data.match(/^\[-u,/g)) {
        grunt.verbose.debug(data.replace(/[\n\r]/g, ''));
      }
      if (typeof data === 'string' && data.match(/Connected\! You may start your tests/)) {
        grunt.verbose.ok('=> Sauce Labs Tunnel established');
        if (!calledBack) {
          calledBack = true;
          callback(true);
        }
      }
    });

    this.proc.stderr.on('data', function(data) {
      grunt.log.error(data.toString().replace(/[\n\r]/g, ''));
    });

    this.proc.on('exit', function(code) {
      grunt.verbose.ok('Sauce Labs Tunnel disconnected ', code);
      if (!calledBack) {
        calledBack = true;
        callback(false);
      }
    });
  };

  SauceTunnel.prototype.getTunnels = function(callback) {
    rqst({
      url: this.baseUrl + '/tunnels',
      json: true
    }, function(err, resp, body) {
      callback(body);
    });
  };

  SauceTunnel.prototype.killAllTunnels = function(callback) {
    if (!this.tunneled) {
      return callback();
    }
    var me = this;
    grunt.verbose.debug("Trying to kill all tunnels");
    this.getTunnels(function(tunnels) {
      (function killTunnel(i) {
        if (i >= tunnels.length) {
          setTimeout(callback, 1000 * 5);
          return;
        }
        grunt.log.writeln("=> Killing tunnel %s", tunnels[i]);
        rqst({
          method: "DELETE",
          url: me.baseUrl + "/tunnels/" + tunnels[i],
          json: true
        }, function() {
          killTunnel(i + 1);
        });
      }(0));
    });
  };

  SauceTunnel.prototype.start = function(callback) {
    var me = this;
    if (!this.tunneled) {
      return callback(true);
    }
    this.getTunnels(function(tunnels) {
      if (!tunnels) {
        grunt.verbose.error("=> Could not get tunnels for Sauce Labs. Still continuing to try connecting to Sauce Labs".inverse);
      }
      if (tunnels && tunnels.length > 0) {
        grunt.log.writeln("=> Looks like there are existing tunnels to Sauce Labs, need to kill them. TunnelID:%s", tunnels);
        (function waitForTunnelsToDie(retryCount) {
          if (retryCount > 5) {
            grunt.verbose.writeln("=> Waited for %s retries, now trying to shut down all tunnels and try again", retryCount);
            me.killAllTunnels(function() {
              me.start(callback);
            });
          } else {
            grunt.verbose.debug("=> %s. Sauce Labs tunnels already exist, will try to connect again %s milliseconds.", retryCount, me.tunnelTimeout / 5);
            setTimeout(function() {
              waitForTunnelsToDie(retryCount + 1);
            }, me.tunnelTimeout / 5);
          }
        }(0));
      } else {
        grunt.verbose.writeln("=> Sauce Labs trying to open tunnel".inverse);
        me.openTunnel(function(status) {
          callback(status);
        });
      }
    });
  };

  SauceTunnel.prototype.stop = function(callback) {
    if (this.proc) {
      this.proc.kill();
    }
    this.killAllTunnels(function() {
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
        driver.safeEval("JSON.stringify(mocha.results)", function(err, results) {
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
    driver.waitForCondition("mocha.chocoReady", testReadyTimeout, function (err) {
      if (err) {
        grunt.verbose.writeln("[%s] Unable to find `mocha.chocoReady` object. Trying to parse DOM", cfg.prefix);
        var testResult = "mocha-stats"
          , resultRegexp = /passes: (\d*)failures: (\d*)duration: ([d\,.]*)s/
          , currentState = null
          , retryCount = 0;
        
        driver.waitForElementById(testResult, testReadyTimeout, function () {
          grunt.verbose.writeln("[%s] Found the test div, fetching the test results elements", cfg.prefix);
          driver.elementById(testResult, function (err, el) {
            if (err) {
              grunt.log.error("[%s] Could not read test result for %s", cfg.prefix, driver.page);
              grunt.log.error("[%s] %s", err);
              grunt.log.error("[%s] More details at http://saucelabs.com/tests/%s", cfg.prefix, driver.page);
              callback(false);
              return;
            } else {
              callback(true); // @TODO: fix this ungodly hack.
              grunt.log.writeln("Test Video: http://saucelabs.com/tests/%s", driver.sessionID);
            }
          });
        });
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

  /*
  * The grunt task for running Mocha tests on Saucelabs
  */
  grunt.registerMultiTask('saucelabs-mocha', 'Run Mocha test cases using Sauce Labs browsers', function() {
    var done = this.async(),
        arg = defaults(this.options(defaultsObj));
    var tunnel = new SauceTunnel(arg.username, arg.key, arg.identifier, arg.tunneled, arg.tunnelTimeout);

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
