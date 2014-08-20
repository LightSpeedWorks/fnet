// fnet.js

'use strict';

(function () {

  var fs = require('fs');
  var util = require('util');
  var path = require('path');
  var events = require('events');
  var co = require('co');
  var cofs = require('co-fs');
  var chan = require('co-chan');
  var mkdirParents = require('mkdir-parents');
  var rmdirRecursive = require('rmdir-recursive');

  // timer
  function timer(ms) {
    var cb;
    setTimeout(function () { if (cb) cb(); }, ms);
    return function (fn) { cb = fn; };
  }

  // hostname ホスト名
  var hostname = (process.env.HOSTNAME || process.env.COMPUTERNAME).toLowerCase();

  // config 設定
  var config = {
    dir: '/tmp/proxy_wk'
  };

// svrDir = path.resolve(dir, 'svr'); // svr watch read, cli write

  var cliSocNo = 0;
  //----------------------------------------------------------------------
  // nextCliSocNo
  function nextCliSocNo() {
    return ++cliSocNo;
  }

  //----------------------------------------------------------------------
  // pad
  function pad(n, m) {
    return ('0000000000' + String(n)).slice(-m);
  }

  //----------------------------------------------------------------------
  // svrDirName
  function svrDirName(svr, port) {
    return 'svr_' + svr + '_' + port;
  }

  //----------------------------------------------------------------------
  // cliDirName
  function cliDirName(port) {
    return 'cli_' + hostname + '_' + process.pid + '_' + pad(port, 8);
  }

  //######################################################################
  // FnetSocket ソケット
  util.inherits(FnetSocket, events.EventEmitter);
  function FnetSocket() {
    var soc = this;
    events.EventEmitter.call(soc);
    soc.$no = nextCliSocNo();
    soc.$socDir = cliDirName(soc.$no);
    soc.$reading = false;
    soc.$readBuffs = [];
    soc.$writeChan = chan();
    soc.$writeSeq = 0;
    soc.$isClosed = false;
    //console.log('open  ' + soc.$socDir);
  }

  //----------------------------------------------------------------------
  // FnetSocket.connect 接続
  FnetSocket.prototype.connect = FnetSocket_connect;
  function FnetSocket_connect(port, host, cb) {
    var soc = this;

    if (typeof host === 'function')
      cb = host, host = undefined;

    if (typeof port === 'undefined')
      port = 'default';

    if (typeof cb === 'function')
      soc.on('connect', cb);

    soc.$remoteDir = svrDirName(host, port);

    // new thread
    co(function*(){
      var cliDir = path.resolve(config.dir, soc.$socDir);
      var remoteDir = path.resolve(config.dir, soc.$remoteDir);

      try {
        yield rmdirRecursive(cliDir);
        try {
          yield mkdirParents(cliDir);
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
        //yield cofs.writeFile(path.resolve(cliDir, 'pid.txt'), process.pid);
        // soc.emit('error', err);

        var cliDirWatchChan = chan();
        var cliDirWatch = fs.watch(cliDir, cliDirWatchChan);

        var conFile = path.resolve(remoteDir, 'con_' + host + '_' + soc.$no);
        yield cofs.writeFile(conFile + '.tmp', soc.$socDir);
        yield cofs.rename(conFile + '.tmp', conFile + '.txt');

        loop: for (;;) {
          yield cliDirWatchChan;
          if (soc.$reading) continue; // 連続起動防止
          soc.$reading = true;

          var names = yield cofs.readdir(cliDir);

          for (var i in names) {
            var name = names[i];
            if (name === 'pid.txt') continue;
            var postfix = name.slice(-4);
            if (postfix === '.tmp') continue;

            var prefix = name.slice(0,4);
            var file = path.resolve(cliDir, name);
            if (prefix === 'ack_') {
              var contents = yield cofs.readFile(file);
              contents = String(contents);
              yield cofs.unlink(file);
              //soc.readStart();
              soc.writeStart(contents);
              soc.emit('connect');
              continue;
            }
            if (prefix === 'dat_') {
              var contents = yield cofs.readFile(file);
              yield cofs.unlink(file);
              soc.$readBuffs.push(contents);
              soc.emit('readable');
              continue;
            }
            if (prefix === 'end_') {
              yield cofs.unlink(file);
              if (soc.$readBuffs.length === 0) {
                soc.emit('end');
                break loop;
              }
              soc.$readBuffs.push('end');
              soc.emit('readable');
              break loop;
            }
            console.log('cli ? ' + name + ' / ' + cliDir);

          } // for i in names

          soc.$reading = false;

        } // for (;;)

      } catch (err) {
        soc.emit('error', err);
        throw new err;
      } finally {
        yield timer(1000);
        if (cliDirWatch) cliDirWatch.close();
        yield rmdirRecursive(cliDir);
      }
      //console.log('close ' + soc.$socDir);

    })();

  } // FnetSocket_connect

  //----------------------------------------------------------------------
  // fnet.createConnection 接続を作成(クライアント)
  function Fnet_createConnection(port, host, cb) {
    var soc = new FnetSocket();
    soc.connect.apply(soc, arguments);
    return soc;
  } // createConnection

  //----------------------------------------------------------------------
  // FnetSocket.write 書込み
  FnetSocket.prototype.write = FnetSocket_write;
  function FnetSocket_write(buff) {
    var soc = this;
    if (soc.$isClosed) return console.log('soc: already closed!!!!');
    if (typeof buff === 'string' || buff instanceof String) buff = new Buffer(buff);
    if (!(buff instanceof Buffer)) {
      console.log('soc write type is wrong! ' + typeof buff + ' ' + util.inspect(buff));
      if (typeof buff === 'object') console.log(buff.constructor.name);
    }
    soc.$writeChan(buff);
  }

  //----------------------------------------------------------------------
  // FnetSocket.end 終了(クローズ)
  FnetSocket.prototype.end = FnetSocket_end;
  function FnetSocket_end(buff) {
    var soc = this;
    if (soc.$isClosed) return;
    if (buff) soc.$writeChan(buff);
    soc.$writeChan.close();
    soc.$isClosed = true;
  }

  //----------------------------------------------------------------------
  // FnetSocket.read 読込み
  FnetSocket.prototype.read = FnetSocket_read;
  function FnetSocket_read() {
    var soc = this;
    if (soc.$readBuffs.length === 0) return null;
    if (soc.$readBuffs.length > 1) {
      process.nextTick(function () {
        soc.emit('readable');
      });
    }
    var buff = soc.$readBuffs.shift();
    if (buff instanceof Buffer) return buff;
    if (buff === 'end') {
      process.nextTick(function () { soc.on('end'); });
      return null;
    }
    return null;
  }

  //----------------------------------------------------------------------
  // FnetSocket.readStart
  FnetSocket.prototype.readStart = FnetSocket_readStart;
  function FnetSocket_readStart() {
    var soc = this;

    // new thread
    co(function*(){
      var cliDir = path.resolve(config.dir, soc.$socDir);

      try {
        try {
          yield mkdirParents(cliDir);
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
        //yield cofs.writeFile(path.resolve(cliDir, 'pid.txt'), process.pid);
        // soc.emit('error', err);

        var cliDirWatchChan = chan();
        var cliDirWatch = fs.watch(cliDir, cliDirWatchChan);

        loop: for (;;) {
          yield cliDirWatchChan;
          if (soc.$reading) continue; // 連続起動防止
          soc.$reading = true;

          var names = yield cofs.readdir(cliDir);

          for (var i in names) {
            var name = names[i];
            if (name === 'pid.txt') continue;
            var postfix = name.slice(-4);
            if (postfix === '.tmp') continue;

            var prefix = name.slice(0,4);
            var file = path.resolve(cliDir, name);
            if (prefix === 'dat_') {
              var contents = yield cofs.readFile(file);
              yield cofs.unlink(file);
              soc.$readBuffs.push(contents);
              soc.emit('readable');
              continue;
            }
            if (prefix === 'end_') {
              yield cofs.unlink(file);
              if (soc.$readBuffs.length === 0) {
                soc.emit('end');
                break loop;
              }
              soc.$readBuffs.push('end');
              soc.emit('readable');
              break loop;
            }

            console.log('cli ? ' + name + ' / ' + cliDir);

          } // for i in names

          soc.$reading = false;

        } // for (;;)

      } catch (err) {
        soc.emit('error', err);
        throw new err;
      } finally {
        yield timer(1000);
        if (cliDirWatch) cliDirWatch.close();
        yield rmdirRecursive(cliDir);
      }

    })();
  }

  //----------------------------------------------------------------------
  // FnetSocket.writeStart 書込み開始
  FnetSocket.prototype.writeStart = FnetSocket_writeStart;
  function FnetSocket_writeStart(remotePath) {
    var soc = this;
    soc.$remotePath = remotePath;
    co(function*() {
      try {
        while (!soc.$writeChan.done()) {
          var buff = yield soc.$writeChan;
          if (buff === soc.$writeChan.empty) continue;
          if (buff instanceof String || typeof buff === 'string') buff = new Buffer(buff);
          if (!(buff instanceof Buffer)) {
            //throw new Error('write arg must be String or Buffer! ' + typeof buff + ' ' + util.inspect(buff));
            console.log('write arg must be String or Buffer! ' + typeof buff + ' ' + util.inspect(buff));
            continue;
          }
          var file = path.resolve(config.dir, soc.$remotePath, 'dat_' + pad(++soc.$writeSeq, 8));
          yield cofs.writeFile(file + '.tmp', buff);
          yield cofs.rename(file + '.tmp', file + '.txt');
        }
      } catch (err) {
        throw err;
      } finally {
        var file = path.resolve(config.dir, soc.$remotePath, 'end_' + pad(++soc.$writeSeq, 8));
        yield cofs.writeFile(file + '.tmp', '');
        yield cofs.rename(file + '.tmp', file + '.txt');
      }
    })();
  }

  //######################################################################
  // FnetServer サーバ
  util.inherits(FnetServer, events.EventEmitter);
  function FnetServer() {
    var server = this;
    events.EventEmitter.call(server);
    server.$connections = {};
    server.$reading = false;
    server.$socDirs = [];
  } // Server

  //----------------------------------------------------------------------
  // FnetServer.listen リッスン
  FnetServer.prototype.listen = FnetServer_listen;
  function FnetServer_listen(port, cb) {
    var server = this;
    // server.$reading = false;

    if (typeof port === 'function')
      cb = port, port = undefined;

    if (typeof cb === 'function')
      server.on('listening', cb);

    // new thread
    co(function*(){
      try {
        port = String(port);
        var svrDir = path.resolve(config.dir, svrDirName(hostname, port));
        server.$socDirs.push([port, svrDir]);

        var svrDirWatchChan = chan();

        yield rmdirRecursive(svrDir);
        yield mkdirParents(svrDir);
        //yield cofs.writeFile(path.resolve(svrDir, 'pid.txt'), process.pid);
        var svrDirWatch = fs.watch(svrDir, svrDirWatchChan);
        server.emit('listening');
        for (;;) {
          yield svrDirWatchChan;

          if (server.$reading) continue; // 連続起動防止
          server.$reading = true;

          var names = yield cofs.readdir(svrDir);

          for (var i in names) {
            var name = names[i];
            if (name === 'pid.txt') continue;

            if (!(name in server.$connections)) {
              var postfix = name.slice(-4);
              if (postfix === '.tmp') continue;

              var prefix = name.slice(0,4);
              // connect request 接続要求
              if (prefix === 'con_') {
                //console.log('svr con: ' + name);
                var contents = yield cofs.readFile(path.resolve(svrDir, name));
                contents = String(contents);
                //console.log(contents);
                yield cofs.unlink(path.resolve(svrDir, name));

                var cli = new FnetSocket();
                var socDir = cli.$socDir;
                try {
                  yield mkdirParents(path.resolve(config.dir, socDir));
                } catch (err) {
                  if (err.code !== 'EEXIST') throw err;
                }
                cli.readStart();
                server.$connections[socDir] = cli;
                var file = path.resolve(config.dir, contents, 'ack_' + cli.$no);
                yield cofs.writeFile(file + '.tmp', socDir);
                yield cofs.rename(file + '.tmp', file + '.txt');
                cli.writeStart(contents);
                server.emit('connection', cli);
                continue;
              }

              //console.log('svr new: ' + name);
              //// new server socket
              //server.$connections[name] = new FnetSocket();
            }
          } // for i in names

          server.$reading = false;

        } // for (;;)

        this.emit('listening');
      } catch (err) {
        throw err;
      } finally {
        yield timer(1000);
        if (svrDirWatch) svrDirWatch.close();
      }

    })();

    return this; // server

  } // FnetServer_listen

  //----------------------------------------------------------------------
  // fnet.createServer サーバを作成
  function Fnet_createServer(cb) {
    var server = new FnetServer();

    if (typeof cb === 'function')
      server.on('connection', cb);

    return server;
  }

  //----------------------------------------------------------------------
  // setConfig
  function Fnet_setConfig(options) {
    for (var key in options) {
      if (!(key in config)) throw new Error('invalid key: ' + key);
      config[key] = options[key];
    }
  }

  function Fnet() {};
  var fnet = new Fnet();

  // fnet object
  fnet.Server = FnetServer;
  fnet.Socket = FnetSocket;
  fnet.createServer = Fnet_createServer;
  fnet.createConnection = Fnet_createConnection;
  fnet.connect = Fnet_createConnection;
  fnet.setConfig = Fnet_setConfig;

  exports = module.exports = fnet;

})();
