'use strict';

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const Json2iob = require('json2iob');
const { CookieJar } = require('tough-cookie');
const { HttpsCookieAgent } = require('http-cookie-agent/http');

class Omada extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'omada',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.deviceArray = [];
    this.wlans = [];
    this.clients = [];
    this.insights = [];
    this.ssids = {};
    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
    this.json2iob = new Json2iob(this);
    const jar = new CookieJar();
    this.requestClient = axios.create({
      httpsAgent: new HttpsCookieAgent({
        rejectUnauthorized: false,
        cookies: { jar },
      }),
    });
    this.requestClient.interceptors.response.use((response) => {
      if (typeof response.data === 'string' && response.data.includes('<html')) {
        this.log.warn('Received HTML instead of JSON. Session expired. Refresh Token in 5 seconds');
        this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
        this.refreshTokenTimeout = setTimeout(() => {
          this.refreshToken();
        }, 5000);
        return Promise.reject(new Error('Session expired - received HTML response'));
      }
      return response;
    });
    this.omadacId = '';
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }
    this.isCloud = this.config.connectionType === 'cloud';
    if (this.isCloud) {
      if (!this.config.cloudUrl || !this.config.cloudOmadacId || !this.config.clientId || !this.config.clientSecret) {
        this.log.error('Please set Open API URL, Omada ID, Client ID and Client Secret in the instance settings');
        return;
      }
      this.baseUrl = this.config.cloudUrl.trim().replace(/\/+$/, '');
      this.omadacId = this.config.cloudOmadacId.trim();
    } else {
      if (!this.config.ip || !this.config.username || !this.config.password) {
        this.log.error('Please set username and password in the instance settings');
        return;
      }
      this.baseUrl = `https://${this.config.ip}:${this.config.port}`;
    }

    this.subscribeStates('*');

    this.log.info('Login to Omada ' + this.baseUrl);
    await this.login();
    if (this.session.token) {
      await this.getDeviceList();
      await this.updateDevices();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, this.config.interval * 1000);
    }
    // Open API access tokens expire after 2 hours
    this.refreshTokenInterval = setInterval(
      () => {
        this.refreshToken();
      },
      (this.isCloud ? 1 : 6) * 60 * 60 * 1000,
    );
  }
  async login() {
    if (this.isCloud) {
      await this.loginCloud();
      return;
    }
    await this.requestClient({
      method: 'get',
      url: `${this.baseUrl}/api/info`,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data && res.data.result && res.data.result.omadacId) {
          this.omadacId = res.data.result.omadacId;
          this.log.info(`Omada cID: ${this.omadacId}`);
        } else {
          this.log.debug('Omada cID not found');
        }
      })
      .catch((error) => {
        this.log.error(error);
        this.log.error('Login failed');
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    await this.requestClient({
      method: 'post',
      url: `${this.baseUrl}/${this.omadacId}/api/v2/login`,
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json; charset=UTF-8',
      },
      data: {
        username: this.config.username,
        password: this.config.password,
      },
    })
      .then((res) => {
        //  this.log.debug(JSON.stringify(res.data));
        if (res.data.result && res.data.result.token) {
          this.log.info('Login successful');
          this.session = res.data.result;
          this.setState('info.connection', true, true);
        } else {
          this.log.error('Login failed: ' + JSON.stringify(res.data));
          return;
        }
      })
      .catch((error) => {
        this.log.error(error);
        this.log.error('Login failed');
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  // Omada Open API (cloud based controller) using client credentials
  async loginCloud() {
    await this.requestClient({
      method: 'post',
      url: `${this.baseUrl}/openapi/authorize/token?grant_type=client_credentials`,
      headers: {
        'Content-Type': 'application/json',
      },
      data: {
        omadacId: this.omadacId,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      },
    })
      .then((res) => {
        if (res.data.errorCode === 0 && res.data.result && res.data.result.accessToken) {
          this.log.info('Login successful');
          this.session = { token: res.data.result.accessToken };
          this.setState('info.connection', true, true);
        } else {
          this.log.error('Login failed: ' + JSON.stringify(res.data));
        }
      })
      .catch((error) => {
        this.log.error(error);
        this.log.error('Login failed');
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  getHeaders() {
    if (this.isCloud) {
      return {
        Accept: 'application/json',
        Authorization: `AccessToken=${this.session.token}`,
      };
    }
    return {
      Accept: 'application/json, text/plain, */*',
      'Csrf-Token': this.session.token,
      'Omada-Request-Source': 'web-local',
    };
  }

  isTokenExpired(errorCode) {
    // -1200: local session expired, -44112/-44113: Open API access token expired/invalid
    return [-1200, -44112, -44113].includes(errorCode);
  }

  async getDeviceList() {
    await this.requestClient({
      method: 'get',
      url: this.isCloud
        ? `${this.baseUrl}/openapi/v1/${this.omadacId}/sites?page=1&pageSize=100`
        : `${this.baseUrl}/${this.omadacId}/api/v2/sites?currentPageSize=100&currentPage=1`,
      headers: this.getHeaders(),
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.result && res.data.result.data) {
          this.log.info(`Found ${res.data.result.data.length} sites`);
          for (const device of res.data.result.data) {
            delete device.deviceAccount;
            this.log.debug(JSON.stringify(device));
            const id = device.id || device.siteId;

            this.deviceArray.push({ ...device, id });
            const name = device.name;

            await this.setObjectNotExistsAsync(id, {
              type: 'device',
              common: {
                name: name,
              },
              native: {},
            });
            await this.setObjectNotExistsAsync(id + '.remote', {
              type: 'channel',
              common: {
                name: 'Remote Controls',
              },
              native: {},
            });

            const remoteArray = [{ command: 'Refresh', name: 'True = Refresh' }];
            remoteArray.forEach((remote) => {
              this.setObjectNotExists(id + '.remote.' + remote.command, {
                type: 'state',
                common: {
                  name: remote.name || '',
                  type: remote.type || 'boolean',
                  role: remote.role || 'button',
                  def: remote.def != null ? remote.def : false,
                  write: true,
                  read: true,
                },
                native: {},
              });
            });
            this.json2iob.parse(id + '.general', device, { forceIndex: true });
            await this.delObjectAsync(id + '.clients', { recursive: true });
            await this.delObjectAsync(id + '.insight', { recursive: true });
          }
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async updateDevices() {
    // let dateMinus7Days = new Date();
    // dateMinus7Days.setDate(dateMinus7Days.getDate() - 7);
    // dateMinus7Days = Math.round(dateMinus7Days.getTime() / 1000);
    // const currentDate = Math.round(Date.now() / 1000);
    const statusArray = [
      {
        url: 'sites/$id/clients',
        path: 'clients',
        desc: 'List of clients',
        preferedArrayName: 'mac',
        preferedArrayDesc: 'name',
        deleteBeforeUpdate: false,
        openapi: true,
      },
      {
        url: 'sites/$id/setting/wlans',
        cloudUrl: 'sites/$id/wireless-network/wlans',
        path: 'wlans',
        desc: 'List of wlans',
        preferedArrayName: 'id',
        cloudPreferedArrayName: 'wlanId',
        preferedArrayDesc: 'name',
      },
      {
        url: 'sites/$id/dashboard/overviewDiagram',
        cloudUrl: 'sites/$id/dashboard/overview-diagram',
        path: 'dashboardOverviewDiagram',
        desc: 'Dashboard Overview Diagram',
      },
      {
        url: 'sites/$id/grid/devices?currentPage=1&currentPageSize=500',
        cloudUrl: 'sites/$id/devices?page=1&pageSize=1000',
        path: 'devices',
        desc: 'Devices',
        preferedArrayName: 'mac',
        preferedArrayDesc: 'name',
      },

      {
        url: 'sites/$id/insight/clients?currentPage=1&currentPageSize=500',
        path: 'insight',
        desc: 'Insight Clients',
        preferedArrayName: 'mac',
        preferedArrayDesc: 'name',
        deleteBeforeUpdate: false,
      },
      {
        url: 'sites/$id/site/alerts?currentPage=1&currentPageSize=100',
        cloudUrl: `sites/$id/logs/alerts?page=1&pageSize=100&filters.timeStart=0&filters.timeEnd=${Date.now()}&filters.resolved=false`,
        path: 'alerts',
        desc: 'Alerts',
        forceIndex: true,
      },
    ];

    for (const element of statusArray) {
      // Open API has no equivalent for some endpoints (e.g. insight clients)
      if (this.isCloud && !element.openapi && !element.cloudUrl) {
        continue;
      }
      for (const device of this.deviceArray) {
        const url = (this.isCloud && element.cloudUrl ? element.cloudUrl : element.url).replace('$id', device.id);
        this.log.debug(`start Update ${element.desc} for ${device.name} (${device.id})`);
        const requestConfig = element.openapi
          ? {
              method: 'post',
              url: `${this.baseUrl}/openapi/v2/${this.omadacId}/${url}`,
              headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
              data: { filters: { active: true }, sorts: {}, pageSize: 500, page: 1 },
            }
          : {
              method: 'get',
              url: this.isCloud
                ? `${this.baseUrl}/openapi/v1/${this.omadacId}/${url}`
                : `${this.baseUrl}/${this.omadacId}/api/v2/${url}`,
              headers: this.getHeaders(),
            };
        await this.requestClient(requestConfig)
          .then(async (res) => {
            this.log.debug(element.url);
            this.log.debug(JSON.stringify(res.data));

            if (this.isTokenExpired(res.data.errorCode)) {
              this.log.info('Token expired. Refresh Token in 5 seconds');
              this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
              this.refreshTokenTimeout = setTimeout(() => {
                this.refreshToken();
              }, 5000);
              return;
            }
            if (res.data.errorCode != 0) {
              this.log.error(url);
              this.log.error(JSON.stringify(res.data));
              return;
            }
            if (!res.data.result) {
              return;
            }
            let data = res.data.result;
            if (data.result) {
              data = data.result;
            }

            if (element.path === 'wlans' && (data.data || Array.isArray(data))) {
              this.wlans = data.data || data;
              this.updateSsidSettings();
            }
            if (element.path === 'clients') {
              for (const client of this.clients) {
                if (data.data.filter((e) => e.mac === client.mac).length === 0) {
                  this.log.debug(`delete client ${client.mac} from ${device.name} (${device.id})`);
                  await this.delObjectAsync(device.id + '.clients.' + client.mac, { recursive: true });
                  for (const key in this.json2iob.alreadyCreatedObjects) {
                    if (key.startsWith(device.id + '.clients.' + client.mac)) {
                      delete this.json2iob.alreadyCreatedObjects[key];
                    }
                  }
                }
              }
              this.clients = data.data;
            }
            if (element.path === 'insight') {
              for (const insight of this.insights) {
                if (data.data.filter((e) => e.mac === insight.mac).length === 0) {
                  this.log.debug(`delete insight ${insight.mac} from ${device.name} (${device.id})`);
                  await this.delObjectAsync(device.id + '.insight.' + insight.mac, { recursive: true });
                  for (const key in this.json2iob.alreadyCreatedObjects) {
                    if (key.startsWith(device.id + '.insight.' + insight.mac)) {
                      delete this.json2iob.alreadyCreatedObjects[key];
                    }
                  }
                }
              }
              this.insights = data.data;
            }
            this.log.debug(`start parsing ${element.path} for ${device.name}`);
            await this.json2iob.parse(device.id + '.' + element.path, data, {
              forceIndex: element.forceIndex,
              preferedArrayName: (this.isCloud && element.cloudPreferedArrayName) || element.preferedArrayName,
              preferedArrayDesc: element.preferedArrayDesc,
              channelName: element.desc,
              deleteBeforeUpdate: element.deleteBeforeUpdate,
            });
            this.log.debug(`end parsing ${element.path} for ${device.name}`);
            // await this.setObjectNotExistsAsync(element.path + ".json", {
            //   type: "state",
            //   common: {
            //     name: "Raw JSON",
            //     write: false,
            //     read: true,
            //     type: "string",
            //     role: "json",
            //   },
            //   native: {},
            // });
            // this.setState(element.path + ".json", JSON.stringify(data), true);
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401) {
                error.response && this.log.debug(JSON.stringify(error.response.data));
                this.log.info(element.path + ' receive 401 error. Refresh Token in 5 seconds');
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.refreshToken();
                }, 5000);

                return;
              }
            }
            this.log.error(url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
  }

  async updateSsidSettings() {
    for (const wlan of this.wlans) {
      const url = this.isCloud
        ? `sites/${wlan.site}/wireless-network/wlans/${wlan.wlanId}/ssids?page=1&pageSize=100`
        : 'sites/' + wlan.site + '/setting/wlans/' + wlan.id + '/ssids?currentPage=1&currentPageSize=500';
      await this.requestClient({
        method: 'get',
        url: this.isCloud
          ? `${this.baseUrl}/openapi/v1/${this.omadacId}/${url}`
          : `${this.baseUrl}/${this.omadacId}/api/v2/${url}`,
        headers: this.getHeaders(),
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          if (!res.data.result) {
            return;
          }
          if (this.isTokenExpired(res.data.errorCode)) {
            this.log.info('Token expired. Refresh Token in 5 seconds');
            this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
            this.refreshTokenTimeout = setTimeout(() => {
              this.refreshToken();
            }, 5000);
            return;
          }
          if (res.data.errorCode != 0) {
            this.log.error(url);
            this.log.error(JSON.stringify(res.data));
            return;
          }
          let data = res.data.result;
          if (data.result) {
            data = data.result;
          }

          this.ssids[wlan.site] = data.data;

          await this.json2iob.parse(wlan.site + '.ssids', data, {
            forceIndex: null,
            write: true,
            preferedArrayName: 'id',
            preferedArrayDesc: 'name',
            channelName: 'List of SSIDs',
          });
        })
        .catch((error) => {
          if (error.response) {
            if (error.response.status === 401) {
              error.response && this.log.debug(JSON.stringify(error.response.data));
              this.log.info(' receive 401 error. Refresh Token in 5 seconds');
              this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
              this.refreshTokenTimeout = setTimeout(() => {
                this.refreshToken();
              }, 5000);

              return;
            }
          }
          this.log.error(url);
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }
  async refreshToken() {
    this.log.debug('Refresh token');
    await this.login();
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        const idArray = id.split('.');
        const siteId = idArray[2];
        // const folder = idArray[3];
        const ssidId = idArray[4];
        const command = idArray[5];

        const ssidStatus = this.ssids[siteId].find((ssid) => ssid.id == ssidId);
        if (!ssidStatus) {
          this.log.error('SSID not found');
          return;
        }
        if (this.isCloud && command !== 'ssidEnable') {
          this.log.warn(`Changing ${command} is not supported via Open API. Only ssidEnable can be changed.`);
          return;
        }
        ssidStatus[command] = state.val;
        this.log.debug(JSON.stringify(ssidStatus));
        await this.requestClient(
          this.isCloud
            ? {
                method: 'patch',
                url: `${this.baseUrl}/openapi/v1/${this.omadacId}/sites/${siteId}/wireless-network/ssids/${ssidId}/enable`,
                headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
                data: { ssidEnable: !!state.val },
              }
            : {
                method: 'patch',
                url: `${this.baseUrl}/${this.omadacId}/api/v2/sites/${siteId}/setting/wlans/${ssidStatus.wlanId}/ssids/${ssidId}`,
                headers: {
                  ...this.getHeaders(),
                  'Content-Type': ' application/json;charset=UTF-8',
                },
                data: ssidStatus,
              },
        )
          .then(async (res) => {
            if (res.data.errorCode != 0) {
              this.log.error(JSON.stringify(res.data));
              return;
            }
            this.log.info(JSON.stringify(res.data));
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401) {
                error.response && this.log.debug(JSON.stringify(error.response.data));
                this.log.info(' receive 401 error. Refresh Token in 5 seconds');
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.refreshToken();
                }, 5000);

                return;
              }
            }
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });

        this.refreshTimeout = setTimeout(() => {
          this.updateSsidSettings();
        }, 5000);
      }
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Omada(options);
} else {
  // otherwise start the instance directly
  new Omada();
}
