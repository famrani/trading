import {
    UtilsService,
} from '../services/utils.service';

import express from 'express';
//import { express } from 'express';
import path from 'path';
//const path = require('path');
import fs from 'fs';
//const fs = require('fs');
import bodyParser from "body-parser";
//const bodyParser = require('body-parser');
import http from 'http';
//const http = require('http');
import https from 'https';
//const https = require('https');


export class WebServerComponent {
    private app = express();
    private appHttp = express();
    private port: string | number;
    private portHttp: string | number;
    private router = express.Router();;

    constructor(
        private utilsSvc: UtilsService,
    ) {
    }


    initWebServer() {
        return new Promise((resolve, reject) => {
            this.port = this.utilsSvc.serverPort;
            this.portHttp = this.port + 1;

            this.app.use(function (req, res, next) {
                // Website you wish to allow to connect
                res.setHeader('Access-Control-Allow-Origin', '*');
                // Request methods you wish to allow
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
                // Request headers you wish to allow
                res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
                // Set to true if you need the website to include cookies in the requests sent
                // to the API (e.g. in case you use sessions)
                res.setHeader('Access-Control-Allow-Credentials', 'true');
                // Pass to next layer of middleware
                next();
            })

            // ssl paraneters
            let options = {}
            if (this.utilsSvc.platformEnv === 'prod') {
                options = {
                    key: fs.readFileSync("./sslKeys/kamli.net/kamli.net.key"),
                    cert: fs.readFileSync("./sslKeys/kamli.net/_.kamli.net.crt"),
                    ca: [
                        fs.readFileSync('./sslKeys/kamli.net/GandiStandardSSLCA3.pem')
                    ],
                    port: this.port
                }
            }
            else {
                options = {
                    key: fs.readFileSync("./sslKeys/kamli.net/kamli.net.key"),
                    cert: fs.readFileSync("./sslKeys/kamli.net/_.kamli.net.crt"),
                    ca: [
                        fs.readFileSync('./sslKeys/kamli.net/GandiStandardSSLCA3.pem')
                    ],
                    port: this.port
                }
            }

            this.app.use(bodyParser.json());
            this.app.use(bodyParser.urlencoded({
                extended: true
            }));

            this.router = express.Router();
            this.setRoutes();
            this.app.use('/', this.router); // register our route
            let temp = process.cwd();
            this.app.use(express.static(path.join(temp, './dist')));
            this.app.use(express.static(path.join(temp, './dist2')));

/*            this.app.get('/api/hello', (req, res) => {
                this.generateSvc.callAnimalSuperheroes(req.query.myParam).then(result => { res.send({ result: result }); });
              });*/

            this.app.get('*', (req, res) => {
                res.sendFile(path.join(temp, './dist/index.html'));
                console.log("lol");
            });

            this.appHttp.get('*', (req, res) => {
                let host = req.headers.host.replace(/:\d+$/, ":" + this.port);
                res.redirect('https://' + host);
            });

            let optionsHttp = {
//                port: this.portHttp
            };

            // create the https server
            https.createServer(options, this.app).listen(this.port, () => {
                console.log('https server in env ', this.port);
            });
            http.createServer(optionsHttp, this.appHttp).listen(this.portHttp, () => {
                console.log('http server in env ', this.portHttp);
                resolve(1);
            });

            /*  http.createServer(optionsHttp, this.app).listen(this.portHttp, () => {
                  console.log('http server on port %d - platform = %s', this.portHttp, this.utilsSvc.platformEnv);
                  resolve(1);
              });*/

        })
    }

    setRoutes() {
        this.utilsSvc.setRoutes(this.router);
    }


}
