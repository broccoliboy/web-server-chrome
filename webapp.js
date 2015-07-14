(function(){
    var sockets = chrome.sockets

    function WebApplication(opts) {
        this.opts = opts
        this.handlers = opts.handlers
        this.handlersMatch = []

        for (var i=0; i<this.handlers.length; i++) {
            var repat = this.handlers[i][0]
            this.handlersMatch.push( [new RegExp(repat), this.handlers[i][1]] )
        }

        if (getchromeversion() >= 44) {
            this.host = opts.host || '0.0.0.0'
        } else {
            this.host = opts.host || '127.0.0.1'
        }
        this.port = opts.port
        this.sockInfo = null
        this.lasterr = null
        this.stopped = false
        this.starting = false
        this.started = false
        this.streams = {}
    }

    WebApplication.prototype = {
        error: function(data) {
            console.error(data)
            this.lasterr = data
        },
        stop: function() {
            this.started = false
            chrome.sockets.tcpServer.disconnect(this.sockInfo.socketId, this.onDisconnect.bind(this))
            for (var key in this.streams) {
                this.streams[key].close()
            }
            // also disconnect any open connections...

        },
        onClose: function(info) {
            var err = chrome.runtime.lastError
            if (err) { console.warn(err) }
            this.stopped = true
            this.started = false
            console.log('tcpserver onclose',info)
        },
        onDisconnect: function(info) {
            var err = chrome.runtime.lastError
            if (err) { console.warn(err) }
            this.stopped = true
            this.started = false
            console.log('tcpserver ondisconnect',info)
            if (this.sockInfo) {
                chrome.sockets.tcpServer.close(this.sockInfo.socketId, this.onClose.bind(this))
            }
        },
        onStreamClose: function(stream) {
            console.assert(stream.sockId)
            delete this.streams[stream.sockId]
        },
        start: function() {
            if (this.starting || this.started) { return }
            this.stopped = false
            this.starting = true

            chrome.system.network.getNetworkInterfaces( function(result) {
                if (result) {
                    for (var i=0; i<result.length; i++) {
                        if (result[i].prefixLength == 24) {
                            console.log('found interface address: ' + result[i].address)
                        }
                    }
                }
            })

            sockets.tcpServer.create({name:"listenSocket"},function(sockInfo) {
                this.sockInfo = sockInfo
                sockets.tcpServer.listen(this.sockInfo.socketId,
                                         this.host,
                                         this.port,
                              function(result) {
                                  this.starting = false
                                  if (result < 0) {
                                      this.error({message:'unable to bind to port',
                                                  errno:result})
                                  } else {
                                      this.started = true
                                      console.log('Listening on','http://'+ this.host + ':' + this.port)
                                      this.bindAcceptCallbacks()
                                  }
                              }.bind(this))
            }.bind(this));
        },
        bindAcceptCallbacks: function() {
            sockets.tcpServer.onAcceptError.addListener(this.onAcceptError.bind(this))
            sockets.tcpServer.onAccept.addListener(this.onAccept.bind(this))
        },
        onAcceptError: function(acceptInfo) {
            console.error('accept error',this.sockInfo.socketId,acceptInfo)
            // set unpaused, etc
        },
        onAccept: function(acceptInfo) {
            //console.log('onAccept',acceptInfo);
            if (acceptInfo.socketId) {
                //var stream = new IOStream(acceptInfo.socketId)
                var stream = new IOStream(acceptInfo.clientSocketId)
                this.streams[acceptInfo.clientSocketId] = stream
                stream.addCloseCallback(this.onStreamClose.bind(this))
                var connection = new HTTPConnection(stream)
                connection.addRequestCallback(this.onRequest.bind(this))
                connection.tryRead()
            }
            if (! this.stopped) {
                //this.doAccept() // new API no longer need to call this
            }
        },
        onRequest: function(request) {

            var uri = request.uri;

            // if uri filter is provided, pass uri to it and use returned value as uri
            if (typeof this.opts.uriFilter == 'function') {
                uri = this.opts.uriFilter(uri);
            }

            // if default option is provided, intercept root directory request and server default instead
            if (uri == '/' && this.opts.default) {
                uri = '/' + this.opts.default;
            }

            request.uri = request.path = request.origpath = uri;

            console.log('handle',request.method, request.uri)
            for (var i=0; i<this.handlersMatch.length; i++) {
                var re = this.handlersMatch[i][0]
                var reresult = re.exec(request.uri)
                if (reresult) {
                    var cls = this.handlersMatch[i][1]
                    var requestHandler = new cls(request)
                    requestHandler.app = this
                    requestHandler.request = request
                    var handlerMethod = requestHandler[request.method.toLowerCase()]
                    if (handlerMethod) {
                        handlerMethod.apply(requestHandler, reresult.slice(1))
                        return
                    }
                }
            }
            console.error('unhandled request',request)
            // create a default handler...
            var handler = new BaseHandler(request)
            handler.app = this
            handler.request = request
            handler.write("Unhandled request", 404)
            handler.finish()
        }
    }

    function BaseHandler() {
        this.headersWritten = false
        this.responseHeaders = {}
        this.responseData = []
        this.responseLength = null
    }
    _.extend(BaseHandler.prototype, {
        get_argument: function(key,def) {
            if (this.request.arguments[key] !== undefined) {
                return this.request.arguments[key]
            } else {
                return def
            }
        },
        setHeader: function(k,v) {
            this.responseHeaders[k] = v
        },
        writeHeaders: function(code, callback) {
            if (code === undefined || isNaN(code)) { code = 200 }
            this.headersWritten = true
            var lines = []
            if (code == 200) {
                lines.push('HTTP/1.1 200 OK')
            } else {
                //console.log(this.request.connection.stream.sockId,'response code',code, this.responseLength)
                lines.push('HTTP/1.1 '+ code + ' ' + HTTPRESPONSES[code])
            }
            console.log(this.request.connection.stream.sockId,'response code',code, 'clen',this.responseLength)
            console.assert(typeof this.responseLength == 'number')
            lines.push('content-length: ' + this.responseLength)

            var p = this.request.path.split('.')
            if (p.length > 1 && ! this.isDirectoryListing) {
                var ext = p[p.length-1].toLowerCase()
                if (MIMETYPES[ext]) {
                    this.setHeader('content-type',MIMETYPES[ext])
                }
            }

            for (key in this.responseHeaders) {
                lines.push(key +': '+this.responseHeaders[key])
            }
            lines.push('\r\n')
            var headerstr = lines.join('\r\n')
            //console.log('write headers',headerstr)
            this.request.connection.write(headerstr, callback)
        },
        write: function(data, code) {
            if (code === undefined) { code = 200 }
            this.responseData.push(data)
            this.responseLength += (data.length || data.byteLength)
            // todo - support chunked response?
            if (! this.headersWritten) {
                this.writeHeaders(code)
            }
            for (var i=0; i<this.responseData.length; i++) {
                this.request.connection.write(this.responseData[i])
            }
            this.responseData = []
            this.finish()
        },
        finish: function() {
            if (this.beforefinish) { this.beforefinish() }
            this.request.connection.curRequest = null
            if (this.request.isKeepAlive() && ! this.request.connection.stream.remoteclosed) {
                this.request.connection.tryRead()
                console.log('webapp.finish(keepalive)')
            } else {
                this.request.connection.close()
                console.log('webapp.finish(close)')
            }
        }
    })

    function haveentry(entry) {
        window.fs = new FileSystem(entry)
    }
    window.haveentry = haveentry

    function FileSystem(entry) {
        this.entry = entry
    }
    _.extend(FileSystem.prototype, {
        getByPath: function(path, callback) {
            if (path == '/') {
                callback(this.entry)
                return
            }
            var parts = path.split('/')
            var newpath = parts.slice(1,parts.length)
            recursiveGetEntry(this.entry, newpath, callback)
        }
    })

    window.FileSystem = FileSystem
    window.BaseHandler = BaseHandler
    chrome.WebApplication = WebApplication

})();

