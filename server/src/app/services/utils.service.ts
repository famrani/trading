const parser = require("nsyslog-parser");
const fs = require('fs');
const readline = require('readline');

export const TOKEN_URI = 'https://connect.stripe.com/oauth/token';
export const AUTHORIZE_URI = 'https://connect.stripe.com/oauth/authorize';

export const timer = ms => new Promise(res => setTimeout(res, ms));

export interface Syslogdata {
  newTS: string;
  initialTS: string;
  ipaddress: string;
  macaddress: string;
  pid: string;
  cpetype: string;
  sipusername: string;
  ucplatform: string;
  messageType: SYSLOGMESSAGETYPE;
}

export enum SYSLOGMESSAGETYPE {
  sipregisterrequest = 'sipregisterrequest',
  sipregistersuccess = 'sipregistersuccess',
  sipregisterfailed = 'sipregisterfailed',
  keepalive = 'keepalive',
  agenttype = 'agenttype',
  sipringing = 'sipringing',
  sipconnect = 'sipconnect',
  siteconnect = 'siteconnect',
}

export enum CPETYPE {
  polycom = 'polycom',
  yealink = 'yealink',
  polycomzoom = 'polycomzoom',
}

export class UtilsService {
  public backendConfig;

  public adnStoreId = 0;
  public backendFBstoreId = 1000;

  public backendUrl: string;
  public serverUrl: string;
  public serverUrlShort: string;
  public serverPort: number;

  public stripeClientId: string;
  public stripeStripeSecretKey: string;

  public params;

  public platformEnv = "dev";

  public session;
  public ar = [] as Syslogdata[];
  public op;

  constructor() {
  }

  fileToArray(fileName, arr): Promise<any[]> {
    return new Promise((resolve, reject) => {
      let i = 0;
      let currentDir = process.cwd();
      try {
        //        arr = fs.readFileSync(currentDir + "/" + fileName);
        arr = require(currentDir + "/" + fileName);
        resolve(arr);
      }
      catch (e) {
        reject(e);
      }
    })
  }

  readConfig(configFile: string, env: string) {
    return new Promise((resolve, reject) => {
      this.fileToArray(configFile, this.backendConfig).then(
        data => {
          if (!env) {
            env = data['application'].platform;
            this.platformEnv = env;
          }
          this.backendUrl = data[env]["backendUrl"];
          this.serverUrl = data[env]["serverUrl"];
          this.serverUrlShort = data[env]["serverUrlShort"];
          this.serverPort = data[env]["serverPort"];

          this.stripeClientId = data[env]["stripeConfig"]["CLIENT_ID"];
          this.stripeStripeSecretKey = data[env]["stripeConfig"]["STRIPE_API_SECRET_KEY"];

          resolve(data);
        },
        error => {
          reject(error)
        })
    })
  }

  getParams() {
    process.argv.forEach((val, index, array) => {
      this.params = array.slice();
    })
    if (this.params.length > 2) {
      switch (this.params[2]) {
        case "dev":
        case "test":
        case "demo":
        case "prod":
          this.platformEnv = this.params[2];
          break;
        default:
          this.platformEnv = undefined;
      }
    }
    else {
      this.platformEnv = undefined;
    }
  }

  async parseSyslog(line2) {
    const regexsipinvitepoly = /(.+)\s(\d+\.\d+\.\d+\.\d+).+LOGSTASH\[\-\]:\s(.+)\s(\d+\.\d+\.\d+\.\d+)\s\[.+\|\s*([a-fA-F0-9]{12})\s*].+<sip\:(.+)@(.+)>/g
    const regexsipinviteyealink = /(.+)\s(\d+\.\d+\.\d+\.\d+).+LOGSTASH\[\-\]:\s(.+)\s(\d+\.\d+\.\d+\.\d+)\s\[(\d+\.\d+)\].+<sip\:(.+)@(.+)>/g
    const regexsipacceptpoly = /(.+)\s(\d+\.\d+\.\d+\.\d+).+LOGSTASH\[\-\]:\s(.+)\s(\d+\.\d+\.\d+\.\d+)\s\[.+\|\s*([a-fA-F0-9]{12})\s*].+(SIP\/2\.0\s200\sOK).*/g
    const regexsipacceptyealink = /(.+)\s(\d+\.\d+\.\d+\.\d+).+LOGSTASH\[\-\]:\s(.+)\s(\d+\.\d+\.\d+\.\d+)\s\[(\d+\.\d+)\].+(SIP\/2\.0\s200\sOK).*/g
    const regexagentyealink = /(.+)\s(\d+\.\d+\.\d+\.\d+).+LOGSTASH\[\-\]:\s(.+)\s(\d+\.\d+\.\d+\.\d+)\s\[(\d+\.\d+)\].+User\-Agent:\s(.+)\s\d+\.\d+\.\d+\.\d+.+/g
    const regexsipmessagespoly = /(.+)\s(\d+\.\d+\.\d+\.\d+).+LOGSTASH\[\-\]:\s(.+)\s(\d+\.\d+\.\d+\.\d+)\s\[.+\|\s*([a-fA-F0-9]{12})\s*](.+)/g
    const regexsipinvitezoom = /(.+)\s(\d+\.\d+\.\d+\.\d+).+LOGSTASH\[\-\]:\s+(.+)\s(\d+\.\d+\.\d+\.\d+)\s+([a-fA-F0-9]{12})(.+)/g
    const regexsipmessagespolyzoom = /.+\<sip\:(.+)@.+\>/g
    const regexsite = /([^\s]+)\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\s+LOGSTASH\[\-\]\:\s+(.+)\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+).+ipvp.+/g


    const line = line2;
    let syslogdata: Syslogdata = {} as Syslogdata;
    let m;
    let n;
    if (!m) {
      if (m = regexsipinvitepoly.exec(line)) {
        syslogdata = {} as Syslogdata;
        syslogdata.newTS = m[1] ? m[1] : '';
        syslogdata.ipaddress = m[2] ? m[2] : '';
        syslogdata.initialTS = m[3] ? m[3] : '';
        syslogdata.messageType = SYSLOGMESSAGETYPE.sipregisterrequest;
        syslogdata.macaddress = m[5] ? m[5] : '';
        syslogdata.sipusername = m[6] ? m[6] : '';
        syslogdata.ucplatform = m[7] ? m[7] : '';
        syslogdata.cpetype = CPETYPE.polycom;
      }
    }
    if (!m) {
      if (m = regexsipinviteyealink.exec(line)) {
        syslogdata = {} as Syslogdata;
        syslogdata.newTS = m[1] ? m[1] : '';
        syslogdata.ipaddress = m[2] ? m[2] : '';
        syslogdata.initialTS = m[3] ? m[3] : '';
        syslogdata.messageType = SYSLOGMESSAGETYPE.sipregisterrequest;
        syslogdata.pid = m[5] ? m[5] : '';
        syslogdata.sipusername = m[6] ? m[6] : '';
        syslogdata.ucplatform = m[7] ? m[7] : '';
        syslogdata.cpetype = CPETYPE.yealink;
      }
    }
    if (!m) {
      if (m = regexsipacceptpoly.exec(line)) {
        syslogdata = {} as Syslogdata;
        syslogdata.newTS = m[1] ? m[1] : '';
        syslogdata.ipaddress = m[2] ? m[2] : '';
        syslogdata.initialTS = m[3] ? m[3] : '';
        syslogdata.messageType = SYSLOGMESSAGETYPE.sipregistersuccess;
        syslogdata.macaddress = m[5] ? m[5] : '';
        syslogdata.cpetype = CPETYPE.polycom;
      }
    }
    if (!m) {
      if (m = regexsipacceptyealink.exec(line)) {
        syslogdata = {} as Syslogdata;
        syslogdata.newTS = m[1] ? m[1] : '';
        syslogdata.ipaddress = m[2] ? m[2] : '';
        syslogdata.initialTS = m[3] ? m[3] : '';
        syslogdata.messageType = SYSLOGMESSAGETYPE.sipregistersuccess;
        syslogdata.pid = m[5] ? m[5] : '';
        syslogdata.cpetype = CPETYPE.yealink;
      }
    }
    if (!m) {
      if (m = regexagentyealink.exec(line)) {
        syslogdata = {} as Syslogdata;
        syslogdata.newTS = m[1] ? m[1] : '';
        syslogdata.ipaddress = m[2] ? m[2] : '';
        syslogdata.initialTS = m[3] ? m[3] : '';
        syslogdata.messageType = SYSLOGMESSAGETYPE.agenttype;
        syslogdata.pid = m[5] ? m[5] : '';
        syslogdata.cpetype = m[6] ? m[6] : CPETYPE.yealink;
      }
    }
    if (!m) {
      if (m = regexsipmessagespoly.exec(line)) {
        syslogdata = {} as Syslogdata;
        syslogdata.newTS = m[1] ? m[1] : '';
        syslogdata.ipaddress = m[2] ? m[2] : '';
        syslogdata.initialTS = m[3] ? m[3] : '';
        syslogdata.macaddress = m[5] ? m[5] : '';
        if (m[6] && m[6].indexOf('Ringing') !== -1) {
          syslogdata.messageType = SYSLOGMESSAGETYPE.sipringing;
        }
        if (m[6] && m[6].indexOf('Sending Packet') !== -1) {
          syslogdata.messageType = SYSLOGMESSAGETYPE.sipconnect;
        }
        if (m[6] && (m[6].indexOf('Forbidden') !== -1) || (m[6].indexOf('Unauthorized') !== -1)) {
          syslogdata.messageType = SYSLOGMESSAGETYPE.sipregisterfailed;
        }
        syslogdata.cpetype = m[6] ? m[6] : CPETYPE.polycom;
      }
    }
    if (!m) {
      if (m = regexsipinvitezoom.exec(line)) {
        syslogdata = {} as Syslogdata;
        syslogdata.newTS = m[1] ? m[1] : '';
        syslogdata.ipaddress = m[2] ? m[2] : '';
        syslogdata.initialTS = m[3] ? m[3] : '';
        syslogdata.pid = m[5] ? m[5] : '';
        n = regexsipmessagespolyzoom.exec(line);
        if (n && n[1]) {
          syslogdata.sipusername = n[1];
          syslogdata.messageType = SYSLOGMESSAGETYPE.sipregisterrequest;
        }
        syslogdata.cpetype = CPETYPE.polycomzoom;
      }
    }
    if (!m) {
      if (m = regexsite.exec(line)) {
        syslogdata = {} as Syslogdata;
        syslogdata.newTS = m[1] ? m[1] : '';
        syslogdata.ipaddress = m[2] ? m[2] : '';
        syslogdata.initialTS = m[3] ? m[3] : '';
        syslogdata.messageType = SYSLOGMESSAGETYPE.siteconnect;
        console.log('m=', m);
      }
    }
    if (syslogdata && syslogdata.newTS) {
      let temp: Syslogdata;
      let temp1: number;
      switch (syslogdata.messageType) {
        case SYSLOGMESSAGETYPE.siteconnect:
          temp1 = this.ar && this.ar.findIndex(a =>
            a.messageType === syslogdata.messageType &&
            a.ipaddress === syslogdata.ipaddress
          );
          break;
        case SYSLOGMESSAGETYPE.sipregisterrequest:
          temp1 = this.ar && this.ar.findIndex(a =>
            a.messageType === syslogdata.messageType &&
            a.cpetype === syslogdata.cpetype &&
            a.macaddress === syslogdata.macaddress
          );
          break;
        case SYSLOGMESSAGETYPE.sipregistersuccess:
          temp1 = this.ar && this.ar.findIndex(a =>
            a.messageType === syslogdata.messageType &&
            a.cpetype === syslogdata.cpetype &&
            a.macaddress === syslogdata.macaddress
          );
          break;
        case SYSLOGMESSAGETYPE.agenttype:
          temp1 = this.ar && this.ar.findIndex(a =>
            a.messageType === syslogdata.messageType &&
            a.cpetype === syslogdata.cpetype &&
            a.pid === syslogdata.pid
          );
          break;
      }
      if (temp1 !== -1) {
        temp = this.ar[temp1];
        if (temp && temp.initialTS && syslogdata && syslogdata.initialTS) {
          let tsarray = new Date(temp.initialTS).getTime();
          let tsnew = new Date(syslogdata.initialTS).getTime();
          if (tsnew > tsarray) {
            this.ar.splice(temp1, 1);
            this.ar.push(syslogdata);
          }
        }
      } else {
        this.ar.push(syslogdata);
      }
    }
  }

  async processLineByLine() {
    const fileStream = fs.createReadStream('/var/log/syslog');
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      this.parseSyslog(line);
    }
    console.log('this.ar=', this.ar);
  }

  processLineByLine2() {
    const Tail = require('tail').Tail;

    const mytail = new Tail("/var/log/syslog");

    mytail.on("line", (line) => {
      this.parseSyslog(line);
    });

    mytail.on("error", function (error) {
      console.log('ERROR: ', error);
    });
  }

  setRoutes(router) {
    router.get('/utils/getenv', (req, res) => {
      let status = 200;
      let sessionData = req.session.kamli;
      if (sessionData === undefined) {
        sessionData = {};
      }
      res.json(sessionData).status(status)
    });
    router.get('/utils/getcpesyslog', async (req, res) => {
      console.log('toto');
      let status = 200;
      res.json(this.ar).status(status)
    });
  }

}
