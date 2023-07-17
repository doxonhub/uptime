const https = require("https");
const dayjs = require("dayjs");
const axios = require("axios");
const { Prometheus } = require("../prometheus");
const { log, UP, DOWN, PENDING, MAINTENANCE, flipStatus, TimeLogger, MAX_INTERVAL_SECOND, MIN_INTERVAL_SECOND,
    SQL_DATETIME_FORMAT
} = require("../../src/util");
const { tcping, ping, dnsResolve, checkCertificate, checkStatusCode, getTotalClientInRoom, setting, mssqlQuery, postgresQuery, mysqlQuery, mqttAsync, setSetting, httpNtlm, radius, grpcQuery,
    redisPingAsync, mongodbPing, kafkaProducerAsync
} = require("../util-server");
const { R } = require("redbean-node");
const { BeanModel } = require("redbean-node/dist/bean-model");
const { Notification } = require("../notification");
const { Proxy } = require("../proxy");
const { demoMode } = require("../config");
const version = require("../../package.json").version;
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { CacheableDnsHttpAgent } = require("../cacheable-dns-http-agent");
const { DockerHost } = require("../docker");
const { UptimeCacheList } = require("../uptime-cache-list");
const Gamedig = require("gamedig");
const jsonata = require("jsonata");
const jwt = require("jsonwebtoken");

/**
 * status:
 *      0 = DOWN
 *      1 = UP
 *      2 = PENDING
 *      3 = MAINTENANCE
 */
class Monitor extends BeanModel {

    /**
     * Return an object that ready to parse to JSON for public
     * Only show necessary data to public
     * @returns {Object}
     */
    async toPublicJSON(showTags = false) {
        let obj = {
            id: this.id,
            name: this.name,
            sendUrl: this.sendUrl,
        };

        if (this.sendUrl) {
            obj.url = this.url;
        }

        if (showTags) {
            obj.tags = await this.getTags();
        }
        return obj;
    }

    /**
     * Return an object that ready to parse to JSON
     * @returns {Object}
     */
    async toJSON(includeSensitiveData = true) {

        let notificationIDList = {};

        let list = await R.find("monitor_notification", " monitor_id = ? ", [
            this.id,
        ]);

        for (let bean of list) {
            notificationIDList[bean.notification_id] = true;
        }

        const tags = await this.getTags();

        let screenshot = null;

        if (this.type === "real-browser") {
            screenshot = "/screenshots/" + jwt.sign(this.id, UptimeKumaServer.getInstance().jwtSecret) + ".png";
        }

        let data = {
            id: this.id,
            name: this.name,
            description: this.description,
            pathName: await this.getPathName(),
            parent: this.parent,
            childrenIDs: await Monitor.getAllChildrenIDs(this.id),
            url: this.url,
            method: this.method,
            hostname: this.hostname,
            port: this.port,
            maxretries: this.maxretries,
            weight: this.weight,
            active: await this.isActive(),
            forceInactive: !await Monitor.isParentActive(this.id),
            type: this.type,
            interval: this.interval,
            retryInterval: this.retryInterval,
            resendInterval: this.resendInterval,
            keyword: this.keyword,
            invertKeyword: this.isInvertKeyword(),
            expiryNotification: this.isEnabledExpiryNotification(),
            ignoreTls: this.getIgnoreTls(),
            upsideDown: this.isUpsideDown(),
            packetSize: this.packetSize,
            maxredirects: this.maxredirects,
            accepted_statuscodes: this.getAcceptedStatuscodes(),
            dns_resolve_type: this.dns_resolve_type,
            dns_resolve_server: this.dns_resolve_server,
            dns_last_result: this.dns_last_result,
            docker_container: this.docker_container,
            docker_host: this.docker_host,
            proxyId: this.proxy_id,
            notificationIDList,
            tags: tags,
            maintenance: await Monitor.isUnderMaintenance(this.id),
            mqttTopic: this.mqttTopic,
            mqttSuccessMessage: this.mqttSuccessMessage,
            databaseQuery: this.databaseQuery,
            authMethod: this.authMethod,
            grpcUrl: this.grpcUrl,
            grpcProtobuf: this.grpcProtobuf,
            grpcMethod: this.grpcMethod,
            grpcServiceName: this.grpcServiceName,
            grpcEnableTls: this.getGrpcEnableTls(),
            radiusCalledStationId: this.radiusCalledStationId,
            radiusCallingStationId: this.radiusCallingStationId,
            game: this.game,
            httpBodyEncoding: this.httpBodyEncoding,
            jsonPath: this.jsonPath,
            expectedValue: this.expectedValue,
            kafkaProducerTopic: this.kafkaProducerTopic,
            kafkaProducerBrokers: JSON.parse(this.kafkaProducerBrokers),
            kafkaProducerSsl: this.kafkaProducerSsl === "1" && true || false,
            kafkaProducerAllowAutoTopicCreation: this.kafkaProducerAllowAutoTopicCreation === "1" && true || false,
            kafkaProducerMessage: this.kafkaProducerMessage,
            screenshot,
        };

        if (includeSensitiveData) {
            data = {
                ...data,
                headers: this.headers,
                body: this.body,
                grpcBody: this.grpcBody,
                grpcMetadata: this.grpcMetadata,
                basic_auth_user: this.basic_auth_user,
                basic_auth_pass: this.basic_auth_pass,
                pushToken: this.pushToken,
                databaseConnectionString: this.databaseConnectionString,
                radiusUsername: this.radiusUsername,
                radiusPassword: this.radiusPassword,
                radiusSecret: this.radiusSecret,
                mqttUsername: this.mqttUsername,
                mqttPassword: this.mqttPassword,
                authWorkstation: this.authWorkstation,
                authDomain: this.authDomain,
                tlsCa: this.tlsCa,
                tlsCert: this.tlsCert,
                tlsKey: this.tlsKey,
                kafkaProducerSaslOptions: JSON.parse(this.kafkaProducerSaslOptions),
            };
        }

        data.includeSensitiveData = includeSensitiveData;
        return data;
    }

    /**
	 * Checks if the monitor is active based on itself and its parents
	 * @returns {Promise<Boolean>}
	 */
    async isActive() {
        const parentActive = await Monitor.isParentActive(this.id);

        return (this.active === 1) && parentActive;
    }

    /**
     * Get all tags applied to this monitor
     * @returns {Promise<LooseObject<any>[]>}
     */
    async getTags() {
        return await R.getAll("SELECT mt.*, tag.name, tag.color FROM monitor_tag mt JOIN tag ON mt.tag_id = tag.id WHERE mt.monitor_id = ? ORDER BY tag.name", [ this.id ]);
    }

    /**
     * Encode user and password to Base64 encoding
     * for HTTP "basic" auth, as per RFC-7617
     * @returns {string}
     */
    encodeBase64(user, pass) {
        return Buffer.from(user + ":" + pass).toString("base64");
    }

    /**
     * Is the TLS expiry notification enabled?
     * @returns {boolean}
     */
    isEnabledExpiryNotification() {
        return Boolean(this.expiryNotification);
    }

    /**
     * Parse to boolean
     * @returns {boolean}
     */
    getIgnoreTls() {
        return Boolean(this.ignoreTls);
    }

    /**
     * Parse to boolean
     * @returns {boolean}
     */
    isUpsideDown() {
        return Boolean(this.upsideDown);
    }

    /**
     * Parse to boolean
     * @returns {boolean}
     */
    isInvertKeyword() {
        return Boolean(this.invertKeyword);
    }

    /**
     * Parse to boolean
     * @returns {boolean}
     */
    getGrpcEnableTls() {
        return Boolean(this.grpcEnableTls);
    }

    /**
     * Get accepted status codes
     * @returns {Object}
     */
    getAcceptedStatuscodes() {
        return JSON.parse(this.accepted_statuscodes_json);
    }

    /**
     * Start monitor
     * @param {Server} io Socket server instance
     */
    start(io) {
        let previousBeat = null;
        let retries = 0;

        this.prometheus = new Prometheus(this);

        const beat = async () => {

            let beatInterval = this.interval;

            if (! beatInterval) {
                beatInterval = 1;
            }

            if (demoMode) {
                if (beatInterval < 20) {
                    console.log("beat interval too low, reset to 20s");
                    beatInterval = 20;
                }
            }

            // Expose here for prometheus update
            // undefined if not https
            let tlsInfo = undefined;

            if (!previousBeat || this.type === "push") {
                previousBeat = await R.findOne("heartbeat", " monitor_id = ? ORDER BY time DESC", [
                    this.id,
                ]);
            }

            const isFirstBeat = !previousBeat;

            let bean = R.dispense("heartbeat");
            bean.monitor_id = this.id;
            bean.time = R.isoDateTimeMillis(dayjs.utc());
            bean.status = DOWN;
            bean.downCount = previousBeat?.downCount || 0;

            if (this.isUpsideDown()) {
                bean.status = flipStatus(bean.status);
            }

            // Duration
            if (!isFirstBeat) {
                bean.duration = dayjs(bean.time).diff(dayjs(previousBeat.time), "second");
            } else {
                bean.duration = 0;
            }

            try {
                if (await Monitor.isUnderMaintenance(this.id)) {
                    bean.msg = "Monitor under maintenance";
                    bean.status = MAINTENANCE;
                } else if (this.type === "group") {
                    const children = await Monitor.getChildren(this.id);

                    if (children.length > 0) {
                        bean.status = UP;
                        bean.msg = "All children up and running";
                        for (const child of children) {
                            if (!child.active) {
                                // Ignore inactive childs
                                continue;
                            }
                            const lastBeat = await Monitor.getPreviousHeartbeat(child.id);

                            // Only change state if the monitor is in worse conditions then the ones before
                            if (bean.status === UP && (lastBeat.status === PENDING || lastBeat.status === DOWN)) {
                                bean.status = lastBeat.status;
                            } else if (bean.status === PENDING && lastBeat.status === DOWN) {
                                bean.status = lastBeat.status;
                            }
                        }

                        if (bean.status !== UP) {
                            bean.msg = "Child inaccessible";
                        }
                    } else {
                        // Set status pending if group is empty
                        bean.status = PENDING;
                        bean.msg = "Group empty";
                    }

                } else if (this.type === "http" || this.type === "keyword" || this.type === "json-query") {
                    // Do not do any queries/high loading things before the "bean.ping"
                    let startTime = dayjs().valueOf();

                    // HTTP basic auth
                    let basicAuthHeader = {};
                    if (this.auth_method === "basic") {
                        basicAuthHeader = {
                            "Authorization": "Basic " + this.encodeBase64(this.basic_auth_user, this.basic_auth_pass),
                        };
                    }

                    const httpsAgentOptions = {
                        maxCachedSessions: 0, // Use Custom agent to disable session reuse (https://github.com/nodejs/node/issues/3940)
                        rejectUnauthorized: !this.getIgnoreTls(),
                    };

                    log.debug("monitor", `[${this.name}] Prepare Options for axios`);

                    let contentType = null;
                    let bodyValue = null;

                    if (this.body && (typeof this.body === "string" && this.body.trim().length > 0)) {
                        if (!this.httpBodyEncoding || this.httpBodyEncoding === "json") {
                            try {
                                bodyValue = JSON.parse(this.body);
                                contentType = "application/json";
                            } catch (e) {
                                throw new Error("Your JSON body is invalid. " + e.message);
                            }
                        } else if (this.httpBodyEncoding === "xml") {
                            bodyValue = this.body;
                            contentType = "text/xml; charset=utf-8";
                        }
                    }

                    // Axios Options
                    const options = {
                        url: this.url,
                        method: (this.method || "get").toLowerCase(),
                        timeout: this.interval * 1000 * 0.8,
                        headers: {
                            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
                            "User-Agent": "Uptime-Kuma/" + version,
                            ...(contentType ? { "Content-Type": contentType } : {}),
                            ...(basicAuthHeader),
                            ...(this.headers ? JSON.parse(this.headers) : {})
                        },
                        maxRedirects: this.maxredirects,
                        validateStatus: (status) => {
                            return checkStatusCode(status, this.getAcceptedStatuscodes());
                        },
                    };

                    if (bodyValue) {
                        options.data = bodyValue;
                    }

                    if (this.proxy_id) {
                        const proxy = await R.load("proxy", this.proxy_id);

                        if (proxy && proxy.active) {
                            const { httpAgent, httpsAgent } = Proxy.createAgents(proxy, {
                                httpsAgentOptions: httpsAgentOptions,
                            });

                            options.proxy = false;
                            options.httpAgent = httpAgent;
                            options.httpsAgent = httpsAgent;
                        }
                    }

                    if (!options.httpsAgent) {
                        options.httpsAgent = new https.Agent(httpsAgentOptions);
                    }

                    if (this.auth_method === "mtls") {
                        if (this.tlsCert !== null && this.tlsCert !== "") {
                            options.httpsAgent.options.cert = Buffer.from(this.tlsCert);
                        }
                        if (this.tlsCa !== null && this.tlsCa !== "") {
                            options.httpsAgent.options.ca = Buffer.from(this.tlsCa);
                        }
                        if (this.tlsKey !== null && this.tlsKey !== "") {
                            options.httpsAgent.options.key = Buffer.from(this.tlsKey);
                        }
                    }

                    log.debug("monitor", `[${this.name}] Axios Options: ${JSON.stringify(options)}`);
                    log.debug("monitor", `[${this.name}] Axios Request`);

                    // Make Request
                    let res = await this.makeAxiosRequest(options);

                    bean.msg = `${res.status} - ${res.statusText}`;
                    bean.ping = dayjs().valueOf() - startTime;

                    // Check certificate if https is used
                    let certInfoStartTime = dayjs().valueOf();
                    if (this.getUrl()?.protocol === "https:") {
                        log.debug("monitor", `[${this.name}] Check cert`);
                        try {
                            let tlsInfoObject = checkCertificate(res);
                            tlsInfo = await this.updateTlsInfo(tlsInfoObject);

                            if (!this.getIgnoreTls() && this.isEnabledExpiryNotification()) {
                                log.debug("monitor", `[${this.name}] call checkCertExpiryNotifications`);
                                await this.checkCertExpiryNotifications(tlsInfoObject);
                            }

                        } catch (e) {
                            if (e.message !== "No TLS certificate in response") {
                                log.error("monitor", "Caught error");
                                log.error("monitor", e.message);
                            }
                        }
                    }

                    if (process.env.TIMELOGGER === "1") {
                        log.debug("monitor", "Cert Info Query Time: " + (dayjs().valueOf() - certInfoStartTime) + "ms");
                    }

                    if (process.env.UPTIME_KUMA_LOG_RESPONSE_BODY_MONITOR_ID === this.id) {
                        log.info("monitor", res.data);
                    }

                    if (this.type === "http") {
                        bean.status = UP;
                    } else if (this.type === "keyword") {

                        let data = res.data;

                        // Convert to string for object/array
                        if (typeof data !== "string") {
                            data = JSON.stringify(data);
                        }

                        let keywordFound = data.includes(this.keyword);
                        if (keywordFound === !this.isInvertKeyword()) {
                            bean.msg += ", keyword " + (keywordFound ? "is" : "not") + " found";
                            bean.status = UP;
                        } else {
                            data = data.replace(/<[^>]*>?|[\n\r]|\s+/gm, " ").trim();
                            if (data.length > 50) {
                                data = data.substring(0, 47) + "...";
                            }
                            throw new Error(bean.msg + ", but keyword is " +
                                (keywordFound ? "present" : "not") + " in [" + data + "]");
                        }

                    } else if (this.type === "json-query") {
                        let data = res.data;

                        // convert data to object
                        if (typeof data === "string") {
                            data = JSON.parse(data);
                        }

                        let expression = jsonata(this.jsonPath);

                        let result = await expression.evaluate(data);

                        if (result.toString() === this.expectedValue) {
                            bean.msg += ", expected value is found";
                            bean.status = UP;
                        } else {
                            throw new Error(bean.msg + ", but value is not equal to expected value, value was: [" + result + "]");
                        }
                    }

                } else if (this.type === "port") {
                    bean.ping = await tcping(this.hostname, this.port);
                    bean.msg = "";
                    bean.status = UP;

                } else if (this.type === "ping") {
                    bean.ping = await ping(this.hostname, this.packetSize);
                    bean.msg = "";
                    bean.status = UP;
                } else if (this.type === "dns") {
                    let startTime = dayjs().valueOf();
                    let dnsMessage = "";

                    let dnsRes = await dnsResolve(this.hostname, this.dns_resolve_server, this.port, this.dns_resolve_type);
                    bean.ping = dayjs().valueOf() - startTime;

                    if (this.dns_resolve_type === "A" || this.dns_resolve_type === "AAAA" || this.dns_resolve_type === "TXT") {
                        dnsMessage += "Records: ";
                        dnsMessage += dnsRes.join(" | ");
                    } else if (this.dns_resolve_type === "CNAME" || this.dns_resolve_type === "PTR") {
                        dnsMessage = dnsRes[0];
                    } else if (this.dns_resolve_type === "CAA") {
                        dnsMessage = dnsRes[0].issue;
                    } else if (this.dns_resolve_type === "MX") {
                        dnsRes.forEach(record => {
                            dnsMessage += `Hostname: ${record.exchange} - Priority: ${record.priority} | `;
                        });
                        dnsMessage = dnsMessage.slice(0, -2);
                    } else if (this.dns_resolve_type === "NS") {
                        dnsMessage += "Servers: ";
                        dnsMessage += dnsRes.join(" | ");
                    } else if (this.dns_resolve_type === "SOA") {
                        dnsMessage += `NS-Name: ${dnsRes.nsname} | Hostmaster: ${dnsRes.hostmaster} | Serial: ${dnsRes.serial} | Refresh: ${dnsRes.refresh} | Retry: ${dnsRes.retry} | Expire: ${dnsRes.expire} | MinTTL: ${dnsRes.minttl}`;
                    } else if (this.dns_resolve_type === "SRV") {
                        dnsRes.forEach(record => {
                            dnsMessage += `Name: ${record.name} | Port: ${record.port} | Priority: ${record.priority} | Weight: ${record.weight} | `;
                        });
                        dnsMessage = dnsMessage.slice(0, -2);
                    }

                    if (this.dnsLastResult !== dnsMessage) {
                        R.exec("UPDATE `monitor` SET dns_last_result = ? WHERE id = ? ", [
                            dnsMessage,
                            this.id
                        ]);
                    }

                    bean.msg = dnsMessage;
                    bean.status = UP;
                } else if (this.type === "push") {      // Type: Push
                    log.debug("monitor", `[${this.name}] Checking monitor at ${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}`);
                    const bufferTime = 1000; // 1s buffer to accommodate clock differences

                    if (previousBeat) {
                        const msSinceLastBeat = dayjs.utc().valueOf() - dayjs.utc(previousBeat.time).valueOf();

                        log.debug("monitor", `[${this.name}] msSinceLastBeat = ${msSinceLastBeat}`);

                        // If the previous beat was down or pending we use the regular
                        // beatInterval/retryInterval in the setTimeout further below
                        if (previousBeat.status !== (this.isUpsideDown() ? DOWN : UP) || msSinceLastBeat > beatInterval * 1000 + bufferTime) {
                            throw new Error("No heartbeat in the time window");
                        } else {
                            let timeout = beatInterval * 1000 - msSinceLastBeat;
                            if (timeout < 0) {
                                timeout = bufferTime;
                            } else {
                                timeout += bufferTime;
                            }
                            // No need to insert successful heartbeat for push type, so end here
                            retries = 0;
                            log.debug("monitor", `[${this.name}] timeout = ${timeout}`);
                            this.heartbeatInterval = setTimeout(safeBeat, timeout);
                            return;
                        }
                    } else {
                        throw new Error("No heartbeat in the time window");
                    }

                } else if (this.type === "steam") {
                    const steamApiUrl = "https://api.steampowered.com/IGameServersService/GetServerList/v1/";
                    const steamAPIKey = await setting("steamAPIKey");
                    const filter = `addr\\${this.hostname}:${this.port}`;

                    if (!steamAPIKey) {
                        throw new Error("Steam API Key not found");
                    }

                    let res = await axios.get(steamApiUrl, {
                        timeout: this.interval * 1000 * 0.8,
                        headers: {
                            "Accept": "*/*",
                            "User-Agent": "Uptime-Kuma/" + version,
                        },
                        httpsAgent: CacheableDnsHttpAgent.getHttpsAgent({
                            maxCachedSessions: 0,      // Use Custom agent to disable session reuse (https://github.com/nodejs/node/issues/3940)
                            rejectUnauthorized: !this.getIgnoreTls(),
                        }),
                        httpAgent: CacheableDnsHttpAgent.getHttpAgent({
                            maxCachedSessions: 0,
                        }),
                        maxRedirects: this.maxredirects,
                        validateStatus: (status) => {
                            return checkStatusCode(status, this.getAcceptedStatuscodes());
                        },
                        params: {
                            filter: filter,
                            key: steamAPIKey,
                        }
                    });

                    if (res.data.response && res.data.response.servers && res.data.response.servers.length > 0) {
                        bean.status = UP;
                        bean.msg = res.data.response.servers[0].name;

                        try {
                            bean.ping = await ping(this.hostname, this.packetSize);
                        } catch (_) { }
                    } else {
                        throw new Error("Server not found on Steam");
                    }
                } else if (this.type === "gamedig") {
                    try {
                        const state = await Gamedig.query({
                            type: this.game,
                            host: this.hostname,
                            port: this.port,
                            givenPortOnly: true,
                        });

                        bean.msg = state.name;
                        bean.status = UP;
                        bean.ping = state.ping;
                    } catch (e) {
                        throw new Error(e.message);
                    }
                } else if (this.type === "docker") {
                    log.debug("monitor", `[${this.name}] Prepare Options for Axios`);

                    const dockerHost = await R.load("docker_host", this.docker_host);

                    const options = {
                        url: `/containers/${this.docker_container}/json`,
                        timeout: this.interval * 1000 * 0.8,
                        headers: {
                            "Accept": "*/*",
                            "User-Agent": "Uptime-Kuma/" + version,
                        },
                        httpsAgent: CacheableDnsHttpAgent.getHttpsAgent({
                            maxCachedSessions: 0,      // Use Custom agent to disable session reuse (https://github.com/nodejs/node/issues/3940)
                            rejectUnauthorized: !this.getIgnoreTls(),
                        }),
                        httpAgent: CacheableDnsHttpAgent.getHttpAgent({
                            maxCachedSessions: 0,
                        }),
                    };

                    if (dockerHost._dockerType === "socket") {
                        options.socketPath = dockerHost._dockerDaemon;
                    } else if (dockerHost._dockerType === "tcp") {
                        options.baseURL = DockerHost.patchDockerURL(dockerHost._dockerDaemon);
                    }

                    log.debug("monitor", `[${this.name}] Axios Request`);
                    let res = await axios.request(options);

                    if (res.data.State.Running) {
                        if (res.data.State.Health && res.data.State.Health.Status !== "healthy") {
                            bean.status = PENDING;
                            bean.msg = res.data.State.Health.Status;
                        } else {
                            bean.status = UP;
                            bean.msg = res.data.State.Health ? res.data.State.Health.Status : res.data.State.Status;
                        }
                    } else {
                        throw Error("Container State is " + res.data.State.Status);
                    }
                } else if (this.type === "mqtt") {
                    bean.msg = await mqttAsync(this.hostname, this.mqttTopic, this.mqttSuccessMessage, {
                        port: this.port,
                        username: this.mqttUsername,
                        password: this.mqttPassword,
                        interval: this.interval,
                    });
                    bean.status = UP;
                } else if (this.type === "sqlserver") {
                    let startTime = dayjs().valueOf();

                    await mssqlQuery(this.databaseConnectionString, this.databaseQuery);

                    bean.msg = "";
                    bean.status = UP;
                    bean.ping = dayjs().valueOf() - startTime;
                } else if (this.type === "grpc-keyword") {
                    let startTime = dayjs().valueOf();
                    const options = {
                        grpcUrl: this.grpcUrl,
                        grpcProtobufData: this.grpcProtobuf,
                        grpcServiceName: this.grpcServiceName,
                        grpcEnableTls: this.grpcEnableTls,
                        grpcMethod: this.grpcMethod,
                        grpcBody: this.grpcBody,
                    };
                    const response = await grpcQuery(options);
                    bean.ping = dayjs().valueOf() - startTime;
                    log.debug("monitor:", `gRPC response: ${JSON.stringify(response)}`);
                    let responseData = response.data;
                    if (responseData.length > 50) {
                        responseData = responseData.toString().substring(0, 47) + "...";
                    }
                    if (response.code !== 1) {
                        bean.status = DOWN;
                        bean.msg = `Error in send gRPC ${response.code} ${response.errorMessage}`;
                    } else {
                        let keywordFound = response.data.toString().includes(this.keyword);
                        if (keywordFound === !this.isInvertKeyword()) {
                            bean.status = UP;
                            bean.msg = `${responseData}, keyword [${this.keyword}] ${keywordFound ? "is" : "not"} found`;
                        } else {
                            log.debug("monitor:", `GRPC response [${response.data}] + ", but keyword [${this.keyword}] is ${keywordFound ? "present" : "not"} in [" + ${response.data} + "]"`);
                            bean.status = DOWN;
                            bean.msg = `, but keyword [${this.keyword}] is ${keywordFound ? "present" : "not"} in [" + ${responseData} + "]`;
                        }
                    }
                } else if (this.type === "postgres") {
                    let startTime = dayjs().valueOf();

                    await postgresQuery(this.databaseConnectionString, this.databaseQuery);

                    bean.msg = "";
                    bean.status = UP;
                    bean.ping = dayjs().valueOf() - startTime;
                } else if (this.type === "mysql") {
                    let startTime = dayjs().valueOf();

                    bean.msg = await mysqlQuery(this.databaseConnectionString, this.databaseQuery);
                    bean.status = UP;
                    bean.ping = dayjs().valueOf() - startTime;
                } else if (this.type === "mongodb") {
                    let startTime = dayjs().valueOf();

                    await mongodbPing(this.databaseConnectionString);

                    bean.msg = "";
                    bean.status = UP;
                    bean.ping = dayjs().valueOf() - startTime;

                } else if (this.type === "radius") {
                    let startTime = dayjs().valueOf();

                    // Handle monitors that were created before the
                    // update and as such don't have a value for
                    // this.port.
                    let port;
                    if (this.port == null) {
                        port = 1812;
                    } else {
                        port = this.port;
                    }

                    try {
                        const resp = await radius(
                            this.hostname,
                            this.radiusUsername,
                            this.radiusPassword,
                            this.radiusCalledStationId,
                            this.radiusCallingStationId,
                            this.radiusSecret,
                            port,
                            this.interval * 1000 * 0.8,
                        );
                        if (resp.code) {
                            bean.msg = resp.code;
                        }
                        bean.status = UP;
                    } catch (error) {
                        bean.status = DOWN;
                        if (error.response?.code) {
                            bean.msg = error.response.code;
                        } else {
                            bean.msg = error.message;
                        }
                    }
                    bean.ping = dayjs().valueOf() - startTime;
                } else if (this.type === "redis") {
                    let startTime = dayjs().valueOf();

                    bean.msg = await redisPingAsync(this.databaseConnectionString);
                    bean.status = UP;
                    bean.ping = dayjs().valueOf() - startTime;

                } else if (this.type in UptimeKumaServer.monitorTypeList) {
                    let startTime = dayjs().valueOf();
                    const monitorType = UptimeKumaServer.monitorTypeList[this.type];
                    await monitorType.check(this, bean, UptimeKumaServer.getInstance());
                    if (!bean.ping) {
                        bean.ping = dayjs().valueOf() - startTime;
                    }

                } else if (this.type === "kafka-producer") {
                    let startTime = dayjs().valueOf();

                    bean.msg = await kafkaProducerAsync(
                        JSON.parse(this.kafkaProducerBrokers),
                        this.kafkaProducerTopic,
                        this.kafkaProducerMessage,
                        {
                            allowAutoTopicCreation: this.kafkaProducerAllowAutoTopicCreation,
                            ssl: this.kafkaProducerSsl,
                            clientId: `Uptime-Kuma/${version}`,
                            interval: this.interval,
                        },
                        JSON.parse(this.kafkaProducerSaslOptions),
                    );
                    bean.status = UP;
                    bean.ping = dayjs().valueOf() - startTime;

                } else {
                    throw new Error("Unknown Monitor Type");
                }

                if (this.isUpsideDown()) {
                    bean.status = flipStatus(bean.status);

                    if (bean.status === DOWN) {
                        throw new Error("Flip UP to DOWN");
                    }
                }

                retries = 0;

            } catch (error) {

                bean.msg = error.message;

                // If UP come in here, it must be upside down mode
                // Just reset the retries
                if (this.isUpsideDown() && bean.status === UP) {
                    retries = 0;

                } else if ((this.maxretries > 0) && (retries < this.maxretries)) {
                    retries++;
                    bean.status = PENDING;
                }
            }

            log.debug("monitor", `[${this.name}] Check isImportant`);
            let isImportant = Monitor.isImportantBeat(isFirstBeat, previousBeat?.status, bean.status);

            // Mark as important if status changed, ignore pending pings,
            // Don't notify if disrupted changes to up
            if (isImportant) {
                bean.important = true;

                if (Monitor.isImportantForNotification(isFirstBeat, previousBeat?.status, bean.status)) {
                    log.debug("monitor", `[${this.name}] sendNotification`);
                    await Monitor.sendNotification(isFirstBeat, this, bean);
                } else {
                    log.debug("monitor", `[${this.name}] will not sendNotification because it is (or was) under maintenance`);
                }

                // Reset down count
                bean.downCount = 0;

                // Clear Status Page Cache
                log.debug("monitor", `[${this.name}] apicache clear`);
                apicache.clear();

                UptimeKumaServer.getInstance().sendMaintenanceListByUserID(this.user_id);

            } else {
                bean.important = false;

                if (bean.status === DOWN && this.resendInterval > 0) {
                    ++bean.downCount;
                    if (bean.downCount >= this.resendInterval) {
                        // Send notification again, because we are still DOWN
                        log.debug("monitor", `[${this.name}] sendNotification again: Down Count: ${bean.downCount} | Resend Interval: ${this.resendInterval}`);
                        await Monitor.sendNotification(isFirstBeat, this, bean);

                        // Reset down count
                        bean.downCount = 0;
                    }
                }
            }

            if (bean.status === UP) {
                log.debug("monitor", `Monitor #${this.id} '${this.name}': Successful Response: ${bean.ping} ms | Interval: ${beatInterval} seconds | Type: ${this.type}`);
            } else if (bean.status === PENDING) {
                if (this.retryInterval > 0) {
                    beatInterval = this.retryInterval;
                }
                log.warn("monitor", `Monitor #${this.id} '${this.name}': Pending: ${bean.msg} | Max retries: ${this.maxretries} | Retry: ${retries} | Retry Interval: ${beatInterval} seconds | Type: ${this.type}`);
            } else if (bean.status === MAINTENANCE) {
                log.warn("monitor", `Monitor #${this.id} '${this.name}': Under Maintenance | Type: ${this.type}`);
            } else {
                log.warn("monitor", `Monitor #${this.id} '${this.name}': Failing: ${bean.msg} | Interval: ${beatInterval} seconds | Type: ${this.type} | Down Count: ${bean.downCount} | Resend Interval: ${this.resendInterval}`);
            }

            log.debug("monitor", `[${this.name}] Send to socket`);
            UptimeCacheList.clearCache(this.id);
            io.to(this.user_id).emit("heartbeat", bean.toJSON());
            Monitor.sendStats(io, this.id, this.user_id);

            log.debug("monitor", `[${this.name}] Store`);
            await R.store(bean);

            log.debug("monitor", `[${this.name}] prometheus.update`);
            this.prometheus?.update(bean, tlsInfo);

            previousBeat = bean;

            if (! this.isStop) {
                log.debug("monitor", `[${this.name}] SetTimeout for next check.`);
                this.heartbeatInterval = setTimeout(safeBeat, beatInterval * 1000);
            } else {
                log.info("monitor", `[${this.name}] isStop = true, no next check.`);
            }

        };

        /** Get a heartbeat and handle errors */
        const safeBeat = async () => {
            try {
                await beat();
            } catch (e) {
                console.trace(e);
                UptimeKumaServer.errorLog(e, false);
                log.error("monitor", "Please report to https://github.com/louislam/uptime-kuma/issues");

                if (! this.isStop) {
                    log.info("monitor", "Try to restart the monitor");
                    this.heartbeatInterval = setTimeout(safeBeat, this.interval * 1000);
                }
            }
        };

        // Delay Push Type
        if (this.type === "push") {
            setTimeout(() => {
                safeBeat();
            }, this.interval * 1000);
        } else {
            safeBeat();
        }
    }

    /**
     * Make a request using axios
     * @param {Object} options Options for Axios
     * @param {boolean} finalCall Should this be the final call i.e
     * don't retry on faliure
     * @returns {Object} Axios response
     */
    async makeAxiosRequest(options, finalCall = false) {
        try {
            let res;
            if (this.auth_method === "ntlm") {
                options.httpsAgent.keepAlive = true;

                res = await httpNtlm(options, {
                    username: this.basic_auth_user,
                    password: this.basic_auth_pass,
                    domain: this.authDomain,
                    workstation: this.authWorkstation ? this.authWorkstation : undefined
                });
            } else {
                res = await axios.request(options);
            }

            return res;
        } catch (e) {
            // Fix #2253
            // Read more: https://stackoverflow.com/questions/1759956/curl-error-18-transfer-closed-with-outstanding-read-data-remaining
            if (!finalCall && typeof e.message === "string" && e.message.includes("maxContentLength size of -1 exceeded")) {
                log.debug("monitor", "makeAxiosRequest with gzip");
                options.headers["Accept-Encoding"] = "gzip, deflate";
                return this.makeAxiosRequest(options, true);
            } else {
                if (typeof e.message === "string" && e.message.includes("maxContentLength size of -1 exceeded")) {
                    e.message = "response timeout: incomplete response within a interval";
                }
                throw e;
            }
        }
    }

    /** Stop monitor */
    stop() {
        clearTimeout(this.heartbeatInterval);
        this.isStop = true;

        this.prometheus?.remove();
    }

    /**
     * Get prometheus instance
     * @returns {Prometheus|undefined}
     */
    getPrometheus() {
        return this.prometheus;
    }

    /**
     * Helper Method:
     * returns URL object for further usage
     * returns null if url is invalid
     * @returns {(null|URL)}
     */
    getUrl() {
        try {
            return new URL(this.url);
        } catch (_) {
            return null;
        }
    }

    /**
     * Store TLS info to database
     * @param checkCertificateResult
     * @returns {Promise<Object>}
     */
    async updateTlsInfo(checkCertificateResult) {
        let tlsInfoBean = await R.findOne("monitor_tls_info", "monitor_id = ?", [
            this.id,
        ]);

        if (tlsInfoBean == null) {
            tlsInfoBean = R.dispense("monitor_tls_info");
            tlsInfoBean.monitor_id = this.id;
        } else {

            // Clear sent history if the cert changed.
            try {
                let oldCertInfo = JSON.parse(tlsInfoBean.info_json);

                let isValidObjects = oldCertInfo && oldCertInfo.certInfo && checkCertificateResult && checkCertificateResult.certInfo;

                if (isValidObjects) {
                    if (oldCertInfo.certInfo.fingerprint256 !== checkCertificateResult.certInfo.fingerprint256) {
                        log.debug("monitor", "Resetting sent_history");
                        await R.exec("DELETE FROM notification_sent_history WHERE type = 'certificate' AND monitor_id = ?", [
                            this.id
                        ]);
                    } else {
                        log.debug("monitor", "No need to reset sent_history");
                        log.debug("monitor", oldCertInfo.certInfo.fingerprint256);
                        log.debug("monitor", checkCertificateResult.certInfo.fingerprint256);
                    }
                } else {
                    log.debug("monitor", "Not valid object");
                }
            } catch (e) { }

        }

        tlsInfoBean.info_json = JSON.stringify(checkCertificateResult);
        await R.store(tlsInfoBean);

        return checkCertificateResult;
    }

    /**
     * Send statistics to clients
     * @param {Server} io Socket server instance
     * @param {number} monitorID ID of monitor to send
     * @param {number} userID ID of user to send to
     */
    static async sendStats(io, monitorID, userID) {
        const hasClients = getTotalClientInRoom(io, userID) > 0;

        if (hasClients) {
            await Monitor.sendAvgPing(24, io, monitorID, userID);
            await Monitor.sendUptime(24, io, monitorID, userID);
            await Monitor.sendUptime(24 * 30, io, monitorID, userID);
            await Monitor.sendCertInfo(io, monitorID, userID);
        } else {
            log.debug("monitor", "No clients in the room, no need to send stats");
        }
    }

    /**
     * Send the average ping to user
     * @param {number} duration Hours
     */
    static async sendAvgPing(duration, io, monitorID, userID) {
        const timeLogger = new TimeLogger();

        let avgPing = parseInt(await R.getCell(`
            SELECT AVG(ping)
            FROM heartbeat
            WHERE time > DATETIME('now', ? || ' hours')
            AND ping IS NOT NULL
            AND monitor_id = ? `, [
            -duration,
            monitorID,
        ]));

        timeLogger.print(`[Monitor: ${monitorID}] avgPing`);

        io.to(userID).emit("avgPing", monitorID, avgPing);
    }

    /**
     * Send certificate information to client
     * @param {Server} io Socket server instance
     * @param {number} monitorID ID of monitor to send
     * @param {number} userID ID of user to send to
     */
    static async sendCertInfo(io, monitorID, userID) {
        let tlsInfo = await R.findOne("monitor_tls_info", "monitor_id = ?", [
            monitorID,
        ]);
        if (tlsInfo != null) {
            io.to(userID).emit("certInfo", monitorID, tlsInfo.info_json);
        }
    }

    /**
     * Uptime with calculation
     * Calculation based on:
     * https://www.uptrends.com/support/kb/reporting/calculation-of-uptime-and-downtime
     * @param {number} duration Hours
     * @param {number} monitorID ID of monitor to calculate
     */
    static async calcUptime(duration, monitorID, forceNoCache = false) {

        if (!forceNoCache) {
            let cachedUptime = UptimeCacheList.getUptime(monitorID, duration);
            if (cachedUptime != null) {
                return cachedUptime;
            }
        }

        const timeLogger = new TimeLogger();

        const startTime = R.isoDateTime(dayjs.utc().subtract(duration, "hour"));

        // Handle if heartbeat duration longer than the target duration
        // e.g. If the last beat's duration is bigger that the 24hrs window, it will use the duration between the (beat time - window margin) (THEN case in SQL)
        let result = await R.getRow(`
            SELECT
               -- SUM all duration, also trim off the beat out of time window
                SUM(
                    CASE
                        WHEN (JULIANDAY(\`time\`) - JULIANDAY(?)) * 86400 < duration
                        THEN (JULIANDAY(\`time\`) - JULIANDAY(?)) * 86400
                        ELSE duration
                    END
                ) AS total_duration,

               -- SUM all uptime duration, also trim off the beat out of time window
                SUM(
                    CASE
                        WHEN (status = 1 OR status = 3)
                        THEN
                            CASE
                                WHEN (JULIANDAY(\`time\`) - JULIANDAY(?)) * 86400 < duration
                                    THEN (JULIANDAY(\`time\`) - JULIANDAY(?)) * 86400
                                ELSE duration
                            END
                        END
                ) AS uptime_duration
            FROM heartbeat
            WHERE time > ?
            AND monitor_id = ?
        `, [
            startTime, startTime, startTime, startTime, startTime,
            monitorID,
        ]);

        timeLogger.print(`[Monitor: ${monitorID}][${duration}] sendUptime`);

        let totalDuration = result.total_duration;
        let uptimeDuration = result.uptime_duration;
        let uptime = 0;

        if (totalDuration > 0) {
            uptime = uptimeDuration / totalDuration;
            if (uptime < 0) {
                uptime = 0;
            }

        } else {
            // Handle new monitor with only one beat, because the beat's duration = 0
            let status = parseInt(await R.getCell("SELECT `status` FROM heartbeat WHERE monitor_id = ?", [ monitorID ]));

            if (status === UP) {
                uptime = 1;
            }
        }

        // Cache
        UptimeCacheList.addUptime(monitorID, duration, uptime);

        return uptime;
    }

    /**
     * Send Uptime
     * @param {number} duration Hours
     * @param {Server} io Socket server instance
     * @param {number} monitorID ID of monitor to send
     * @param {number} userID ID of user to send to
     */
    static async sendUptime(duration, io, monitorID, userID) {
        const uptime = await this.calcUptime(duration, monitorID);
        io.to(userID).emit("uptime", monitorID, duration, uptime);
    }

    /**
     * Has status of monitor changed since last beat?
     * @param {boolean} isFirstBeat Is this the first beat of this monitor?
     * @param {const} previousBeatStatus Status of the previous beat
     * @param {const} currentBeatStatus Status of the current beat
     * @returns {boolean} True if is an important beat else false
     */
    static isImportantBeat(isFirstBeat, previousBeatStatus, currentBeatStatus) {
        // * ? -> ANY STATUS = important [isFirstBeat]
        // UP -> PENDING = not important
        // * UP -> DOWN = important
        // UP -> UP = not important
        // PENDING -> PENDING = not important
        // * PENDING -> DOWN = important
        // PENDING -> UP = not important
        // DOWN -> PENDING = this case not exists
        // DOWN -> DOWN = not important
        // * DOWN -> UP = important
        // MAINTENANCE -> MAINTENANCE = not important
        // * MAINTENANCE -> UP = important
        // * MAINTENANCE -> DOWN = important
        // * DOWN -> MAINTENANCE = important
        // * UP -> MAINTENANCE = important
        return isFirstBeat ||
            (previousBeatStatus === DOWN && currentBeatStatus === MAINTENANCE) ||
            (previousBeatStatus === UP && currentBeatStatus === MAINTENANCE) ||
            (previousBeatStatus === MAINTENANCE && currentBeatStatus === DOWN) ||
            (previousBeatStatus === MAINTENANCE && currentBeatStatus === UP) ||
            (previousBeatStatus === UP && currentBeatStatus === DOWN) ||
            (previousBeatStatus === DOWN && currentBeatStatus === UP) ||
            (previousBeatStatus === PENDING && currentBeatStatus === DOWN);
    }

    /**
     * Is this beat important for notifications?
     * @param {boolean} isFirstBeat Is this the first beat of this monitor?
     * @param {const} previousBeatStatus Status of the previous beat
     * @param {const} currentBeatStatus Status of the current beat
     * @returns {boolean} True if is an important beat else false
     */
    static isImportantForNotification(isFirstBeat, previousBeatStatus, currentBeatStatus) {
        // * ? -> ANY STATUS = important [isFirstBeat]
        // UP -> PENDING = not important
        // * UP -> DOWN = important
        // UP -> UP = not important
        // PENDING -> PENDING = not important
        // * PENDING -> DOWN = important
        // PENDING -> UP = not important
        // DOWN -> PENDING = this case not exists
        // DOWN -> DOWN = not important
        // * DOWN -> UP = important
        // MAINTENANCE -> MAINTENANCE = not important
        // MAINTENANCE -> UP = not important
        // * MAINTENANCE -> DOWN = important
        // DOWN -> MAINTENANCE = not important
        // UP -> MAINTENANCE = not important
        return isFirstBeat ||
            (previousBeatStatus === MAINTENANCE && currentBeatStatus === DOWN) ||
            (previousBeatStatus === UP && currentBeatStatus === DOWN) ||
            (previousBeatStatus === DOWN && currentBeatStatus === UP) ||
            (previousBeatStatus === PENDING && currentBeatStatus === DOWN);
    }

    /**
     * Send a notification about a monitor
     * @param {boolean} isFirstBeat Is this beat the first of this monitor?
     * @param {Monitor} monitor The monitor to send a notificaton about
     * @param {Bean} bean Status information about monitor
     */
    static async sendNotification(isFirstBeat, monitor, bean) {
        if (!isFirstBeat || bean.status === DOWN) {
            const notificationList = await Monitor.getNotificationList(monitor);

            let text;
            if (bean.status === UP) {
                text = "✅ Up";
            } else {
                text = "🔴 Down";
            }

            let msg = `[${monitor.name}] [${text}] ${bean.msg}`;

            for (let notification of notificationList) {
                try {
                    const heartbeatJSON = bean.toJSON();

                    // Prevent if the msg is undefined, notifications such as Discord cannot send out.
                    if (!heartbeatJSON["msg"]) {
                        heartbeatJSON["msg"] = "N/A";
                    }

                    // Also provide the time in server timezone
                    heartbeatJSON["timezone"] = await UptimeKumaServer.getInstance().getTimezone();
                    heartbeatJSON["timezoneOffset"] = UptimeKumaServer.getInstance().getTimezoneOffset();
                    heartbeatJSON["localDateTime"] = dayjs.utc(heartbeatJSON["time"]).tz(heartbeatJSON["timezone"]).format(SQL_DATETIME_FORMAT);

                    await Notification.send(JSON.parse(notification.config), msg, await monitor.toJSON(false), heartbeatJSON);
                } catch (e) {
                    log.error("monitor", "Cannot send notification to " + notification.name);
                    log.error("monitor", e);
                }
            }
        }
    }

    /**
     * Get list of notification providers for a given monitor
     * @param {Monitor} monitor Monitor to get notification providers for
     * @returns {Promise<LooseObject<any>[]>}
     */
    static async getNotificationList(monitor) {
        let notificationList = await R.getAll("SELECT notification.* FROM notification, monitor_notification WHERE monitor_id = ? AND monitor_notification.notification_id = notification.id ", [
            monitor.id,
        ]);
        return notificationList;
    }

    /**
     * checks certificate chain for expiring certificates
     * @param {Object} tlsInfoObject Information about certificate
     */
    async checkCertExpiryNotifications(tlsInfoObject) {
        if (tlsInfoObject && tlsInfoObject.certInfo && tlsInfoObject.certInfo.daysRemaining) {
            const notificationList = await Monitor.getNotificationList(this);

            if (! notificationList.length > 0) {
                // fail fast. If no notification is set, all the following checks can be skipped.
                log.debug("monitor", "No notification, no need to send cert notification");
                return;
            }

            let notifyDays = await setting("tlsExpiryNotifyDays");
            if (notifyDays == null || !Array.isArray(notifyDays)) {
                // Reset Default
                setSetting("tlsExpiryNotifyDays", [ 7, 14, 21 ], "general");
                notifyDays = [ 7, 14, 21 ];
            }

            if (Array.isArray(notifyDays)) {
                for (const targetDays of notifyDays) {
                    let certInfo = tlsInfoObject.certInfo;
                    while (certInfo) {
                        let subjectCN = certInfo.subject["CN"];
                        if (certInfo.daysRemaining > targetDays) {
                            log.debug("monitor", `No need to send cert notification for ${certInfo.certType} certificate "${subjectCN}" (${certInfo.daysRemaining} days valid) on ${targetDays} deadline.`);
                        } else {
                            log.debug("monitor", `call sendCertNotificationByTargetDays for ${targetDays} deadline on certificate ${subjectCN}.`);
                            await this.sendCertNotificationByTargetDays(subjectCN, certInfo.certType, certInfo.daysRemaining, targetDays, notificationList);
                        }
                        certInfo = certInfo.issuerCertificate;
                    }
                }
            }
        }
    }

    /**
     * Send a certificate notification when certificate expires in less
     * than target days
     * @param {string} certCN  Common Name attribute from the certificate subject
     * @param {string} certType  certificate type
     * @param {number} daysRemaining Number of days remaining on certificate
     * @param {number} targetDays Number of days to alert after
     * @param {LooseObject<any>[]} notificationList List of notification providers
     * @returns {Promise<void>}
     */
    async sendCertNotificationByTargetDays(certCN, certType, daysRemaining, targetDays, notificationList) {

        let row = await R.getRow("SELECT * FROM notification_sent_history WHERE type = ? AND monitor_id = ? AND days <= ?", [
            "certificate",
            this.id,
            targetDays,
        ]);

        // Sent already, no need to send again
        if (row) {
            log.debug("monitor", "Sent already, no need to send again");
            return;
        }

        let sent = false;
        log.debug("monitor", "Send certificate notification");

        for (let notification of notificationList) {
            try {
                log.debug("monitor", "Sending to " + notification.name);
                await Notification.send(JSON.parse(notification.config), `[${this.name}][${this.url}] ${certType} certificate ${certCN} will be expired in ${daysRemaining} days`);
                sent = true;
            } catch (e) {
                log.error("monitor", "Cannot send cert notification to " + notification.name);
                log.error("monitor", e);
            }
        }

        if (sent) {
            await R.exec("INSERT INTO notification_sent_history (type, monitor_id, days) VALUES(?, ?, ?)", [
                "certificate",
                this.id,
                targetDays,
            ]);
        }
    }

    /**
     * Get the status of the previous heartbeat
     * @param {number} monitorID ID of monitor to check
     * @returns {Promise<LooseObject<any>>}
     */
    static async getPreviousHeartbeat(monitorID) {
        return await R.getRow(`
            SELECT ping, status, time FROM heartbeat
            WHERE id = (select MAX(id) from heartbeat where monitor_id = ?)
        `, [
            monitorID
        ]);
    }

    /**
     * Check if monitor is under maintenance
     * @param {number} monitorID ID of monitor to check
     * @returns {Promise<boolean>}
     */
    static async isUnderMaintenance(monitorID) {
        const maintenanceIDList = await R.getCol(`
            SELECT maintenance_id FROM monitor_maintenance
            WHERE monitor_id = ?
        `, [ monitorID ]);

        for (const maintenanceID of maintenanceIDList) {
            const maintenance = await UptimeKumaServer.getInstance().getMaintenance(maintenanceID);
            if (maintenance && await maintenance.isUnderMaintenance()) {
                return true;
            }
        }

        const parent = await Monitor.getParent(monitorID);
        if (parent != null) {
            return await Monitor.isUnderMaintenance(parent.id);
        }

        return false;
    }

    /** Make sure monitor interval is between bounds */
    validate() {
        if (this.interval > MAX_INTERVAL_SECOND) {
            throw new Error(`Interval cannot be more than ${MAX_INTERVAL_SECOND} seconds`);
        }
        if (this.interval < MIN_INTERVAL_SECOND) {
            throw new Error(`Interval cannot be less than ${MIN_INTERVAL_SECOND} seconds`);
        }
    }

    /**
     * Gets Parent of the monitor
     * @param {number} monitorID ID of monitor to get
     * @returns {Promise<LooseObject<any>>}
     */
    static async getParent(monitorID) {
        return await R.getRow(`
            SELECT parent.* FROM monitor parent
    		LEFT JOIN monitor child
    			ON child.parent = parent.id
            WHERE child.id = ?
        `, [
            monitorID,
        ]);
    }

    /**
     * Gets all Children of the monitor
     * @param {number} monitorID ID of monitor to get
     * @returns {Promise<LooseObject<any>>}
     */
    static async getChildren(monitorID) {
        return await R.getAll(`
            SELECT * FROM monitor
            WHERE parent = ?
        `, [
            monitorID,
        ]);
    }

    /**
     * Gets Full Path-Name (Groups and Name)
     * @returns {Promise<String>}
     */
    async getPathName() {
        let path = this.name;

        if (this.parent === null) {
            return path;
        }

        let parent = await Monitor.getParent(this.id);
        while (parent !== null) {
            path = `${parent.name} / ${path}`;
            parent = await Monitor.getParent(parent.id);
        }

        return path;
    }

    /**
     * Gets recursive all child ids
	 * @param {number} monitorID ID of the monitor to get
     * @returns {Promise<Array>}
     */
    static async getAllChildrenIDs(monitorID) {
        const childs = await Monitor.getChildren(monitorID);

        if (childs === null) {
            return [];
        }

        let childrenIDs = [];

        for (const child of childs) {
            childrenIDs.push(child.id);
            childrenIDs = childrenIDs.concat(await Monitor.getAllChildrenIDs(child.id));
        }

        return childrenIDs;
    }

    /**
     * Unlinks all children of the the group monitor
     * @param {number} groupID ID of group to remove children of
     * @returns {Promise<void>}
     */
    static async unlinkAllChildren(groupID) {
        return await R.exec("UPDATE `monitor` SET parent = ? WHERE parent = ? ", [
            null, groupID
        ]);
    }

    /**
	 * Checks recursive if parent (ancestors) are active
	 * @param {number} monitorID ID of the monitor to get
	 * @returns {Promise<Boolean>}
	 */
    static async isParentActive(monitorID) {
        const parent = await Monitor.getParent(monitorID);

        if (parent === null) {
            return true;
        }

        const parentActive = await Monitor.isParentActive(parent.id);
        return parent.active && parentActive;
    }
}

module.exports = Monitor;