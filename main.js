"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
const Json2iob = require("json2iob");
const { CookieJar } = require("tough-cookie");
const { HttpsCookieAgent } = require("http-cookie-agent/http");

class Omada extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: "omada",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.deviceArray = [];
    this.wlans = [];
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
    this.omadacId = "";
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState("info.connection", false, true);
    // if (this.config.interval < 0.5) {
    //   this.log.info("Set interval to minimum 0.5");
    //   this.config.interval = 0.5;
    // }
    if (!this.config.ip || !this.config.username || !this.config.password) {
      this.log.error("Please set username and password in the instance settings");
      return;
    }

    this.subscribeStates("*");

    this.log.info("Login to Omada " + this.config.ip + ":" + this.config.port);
    await this.login();
    if (this.session.token) {
      await this.getDeviceList();
      await this.updateDevices();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, 5 * 60 * 1000);
    }
    this.refreshTokenInterval = setInterval(() => {
      this.refreshToken();
    }, 24 * 60 * 60 * 1000);
  }
  async login() {
    await this.requestClient({
      method: "get",
      url: `https://${this.config.ip}:${this.config.port}`,
    })
      .then((res) => {
        //this.log.debug(JSON.stringify(res.data));
        this.omadacId = res.request.path.split("/")[1];
        this.log.info(`Omada cID: ${this.omadacId}`);
      })
      .catch((error) => {
        this.log.error(error);
        this.log.error("Login failed");
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    await this.requestClient({
      method: "post",
      url: `https://${this.config.ip}:${this.config.port}/${this.omadacId}/api/v2/login`,
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/json; charset=UTF-8",
      },
      data: {
        username: this.config.username,
        password: this.config.password,
      },
    })
      .then((res) => {
        //  this.log.debug(JSON.stringify(res.data));
        if (res.data.result && res.data.result.token) {
          this.log.info("Login successful");
          this.session = res.data.result;
          this.setState("info.connection", true, true);
        } else {
          this.log.error("Login failed: " + JSON.stringify(res.data));
          return;
        }
      })
      .catch((error) => {
        this.log.error(error);
        this.log.error("Login failed");
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async getDeviceList() {
    await this.requestClient({
      method: "get",
      url: `https://${this.config.ip}:${this.config.port}/${this.omadacId}/api/v2/sites?currentPageSize=100&currentPage=1`,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Csrf-Token": this.session.token,
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.result && res.data.result.data) {
          this.log.info(`Found ${res.data.result.data.length} sites`);
          for (const device of res.data.result.data) {
            delete device.deviceAccount;
            this.log.debug(JSON.stringify(device));
            const id = device.id;

            this.deviceArray.push(device);
            const name = device.name;

            await this.setObjectNotExistsAsync(id, {
              type: "device",
              common: {
                name: name,
              },
              native: {},
            });
            await this.setObjectNotExistsAsync(id + ".remote", {
              type: "channel",
              common: {
                name: "Remote Controls",
              },
              native: {},
            });

            const remoteArray = [{ command: "Refresh", name: "True = Refresh" }];
            remoteArray.forEach((remote) => {
              this.setObjectNotExists(id + ".remote." + remote.command, {
                type: "state",
                common: {
                  name: remote.name || "",
                  type: remote.type || "boolean",
                  role: remote.role || "button",
                  def: remote.def != null ? remote.def : false,
                  write: true,
                  read: true,
                },
                native: {},
              });
            });
            this.json2iob.parse(id + ".general", device, { forceIndex: true });
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
        url: "sites/$id/clients?currentPageSize=500&currentPage=1",
        path: "clients",
        desc: "List of clients",
        preferedArrayName: "mac",
        preferedArrayDesc: "name",
      },
      {
        url: "sites/$id/setting/wlans",
        path: "wlans",
        desc: "List of wlans",
        preferedArrayName: "id",
        preferedArrayDesc: "name",
      },
      {
        url: "sites/$id/dashboard/overviewDiagram",
        path: "dashboardOverviewDiagram",
        desc: "Dashboard Overview Diagram",
      },
      {
        url: "sites/$id/grid/devices?currentPage=1&currentPageSize=500",
        path: "devices",
        desc: "Devices",
        preferedArrayName: "mac",
        preferedArrayDesc: "name",
      },

      {
        url: "sites/$id/insight/clients?currentPage=1&currentPageSize=500",
        path: "insight",
        desc: "Insight Clients",
        preferedArrayName: "mac",
        preferedArrayDesc: "name",
      },
      {
        url: "sites/$id/site/alerts?currentPage=1&currentPageSize=100",
        path: "alerts",
        desc: "Alerts",
        forceIndex: true,
      },
    ];

    for (const element of statusArray) {
      for (const device of this.deviceArray) {
        const url = element.url.replace("$id", device.id);

        await this.requestClient({
          method: "get",
          url: `https://${this.config.ip}:${this.config.port}/${this.omadacId}/api/v2/${url}`,
          headers: {
            Accept: "application/json, text/plain, */*",
            "Csrf-Token": this.session.token,
          },
        })
          .then(async (res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data.result) {
              return;
            }
            if (res.data.errorCode != 0) {
              this.log.error(JSON.stringify(res.data));
              return;
            }
            let data = res.data.result;
            if (data.result) {
              data = data.result;
            }

            if (element.path === "wlans" && data.data) {
              this.wlans = data.data;
              this.updateSsidSettings();
            }
            this.json2iob.parse(device.id + "." + element.path, data, {
              forceIndex: element.forceIndex,
              preferedArrayName: element.preferedArrayName,
              preferedArrayDesc: element.preferedArrayDesc,
              channelName: element.desc,
            });
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
                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.refreshToken();
                }, 1000 * 60);

                return;
              }
            }
            this.log.error(element.url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
  }

  async updateSsidSettings() {
    for (const wlan of this.wlans) {
      const url = "sites/" + wlan.site + "/setting/wlans/" + wlan.id + "/ssids?currentPage=1&currentPageSize=500";
      await this.requestClient({
        method: "get",
        url: `https://${this.config.ip}:${this.config.port}/${this.omadacId}/api/v2/${url}`,
        headers: {
          Accept: "application/json, text/plain, */*",
          "Csrf-Token": this.session.token,
        },
      })
        .then(async (res) => {
          this.log.debug(JSON.stringify(res.data));
          if (!res.data.result) {
            return;
          }
          if (res.data.errorCode != 0) {
            this.log.error(JSON.stringify(res.data));
            return;
          }
          let data = res.data.result;
          if (data.result) {
            data = data.result;
          }

          this.ssids[wlan.site] = data.data;

          this.json2iob.parse(wlan.site + ".ssids", data, {
            forceIndex: null,
            write: true,
            preferedArrayName: "id",
            preferedArrayDesc: "name",
            channelName: "List of SSIDs",
          });
        })
        .catch((error) => {
          if (error.response) {
            if (error.response.status === 401) {
              error.response && this.log.debug(JSON.stringify(error.response.data));
              this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
              this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
              this.refreshTokenTimeout = setTimeout(() => {
                this.refreshToken();
              }, 1000 * 60);

              return;
            }
          }
          this.log.error(element.url);
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }
  async refreshToken() {
    this.log.debug("Refresh token");
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
      this.setState("info.connection", false, true);
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
        const idArray = id.split(".");
        const siteId = idArray[2];
        const folder = idArray[3];
        const ssidId = idArray[4];
        const command = idArray[5];

        const ssidStatus = this.ssids[siteId].find((ssid) => ssid.id == ssidId);
        if (!ssidStatus) {
          this.log.error("SSID not found");
          return;
        }
        ssidStatus[command] = state.val;
        this.log.debug(JSON.stringify(ssidStatus));
        await this.requestClient({
          method: "patch",
          url: `https://${this.config.ip}:${this.config.port}/${this.omadacId}/api/v2/sites/${siteId}/setting/wlans/${ssidStatus.wlanId}/ssids/${ssidId}`,
          headers: {
            "Content-Type": " application/json;charset=UTF-8",
            Accept: "application/json, text/plain, */*",
            "Csrf-Token": this.session.token,
          },
          data: ssidStatus,
        })
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
                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.refreshToken();
                }, 1000 * 60);

                return;
              }
            }
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });

        this.refreshTimeout = setTimeout(() => {
          this.updateSsidSettings();
        }, 5000);
      } else {
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
