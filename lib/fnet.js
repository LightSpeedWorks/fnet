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

  var FINISH_TIMEOUT = 100;
  var LONG_TIMEOUT = 1000 * 3600 * 6;

  // hostname ホスト名
  var hostname = (process.env.PROXY_HOSTNAME || process.env.HOSTNAME || process.env.COMPUTERNAME).toLowerCase();

  // config 設定
  var config = {
    dir: '/tmp/proxy_wk'
  };

  var dirWatches = {}; // key=dirName, value=fs.watch

  //----------------------------------------------------------------------
  // getTermName ファイル名やパス名の末尾の名前を取得(フォルダ名以外)
  function getTermName(file) {
    return file.replace(/\\/g, '/').split('/').pop();
  }

  //----------------------------------------------------------------------
  // exitHandler 終了処理
  function exitHandler(reason) {
    var waitFlag = false;
    console.log('process on %s... pid=%s', reason, process.pid);
    var dirs = Object.keys(dirWatches);
    for (var i in dirs) {
      var dir = dirs[i];
      var watch = dirWatches[dir];
      if (watch) watch.close();
      delete dirWatches[dir];
      var exists = fs.existsSync(dir);
      if (!exists) waitFlag = true;
      var name = getTermName(dir);
      if (exists) console.log('deleting... %s   ', name);
      //console.log('deleting... %s   ', name,
      //   exists ? '' : '*** DOES NOT EXISTS ALREADY ***');
      rmdirRecursive.sync(dir);
    }
    if (reason !== 'exit') {
      if (waitFlag) {
        return setTimeout(function () {
          process.exit();
        }, 100);
      }
      process.exit();
    }
  }

  process.on('SIGHUP', exitHandler.bind(null, 'SIGHUP')); // on console close
  process.on('SIGINT', exitHandler.bind(null, 'SIGINT')); // on control-c
  process.on('exit',   exitHandler.bind(null, 'exit'));   // on exit

  //----------------------------------------------------------------------
  // sleep (co-sleep) 眠る(待つ)
  function sleep(ms) {
    return function (cb) {
      setTimeout(cb, ms);
    };
  }

  var cliSocNo = 0;
  //----------------------------------------------------------------------
  // nextCliSocNo 次のクライアントソケット番号を取得
  function nextCliSocNo() {
    return ++cliSocNo;
  }

  //----------------------------------------------------------------------
  // pad パディング
  function pad(n, m) {
    return ('0000000000' + String(n)).slice(-m);
  }

  //----------------------------------------------------------------------
  // svrDirName サーバ・ディレクトリ名
  function svrDirName(svr, port) {
    return 'svr_' + svr + '_' + port;
  }

  //----------------------------------------------------------------------
  // cliDirName クライアント・ディレクトリ名
  function cliDirName(port) {
    return 'soc_' + hostname + '_pid' + process.pid + '_' + pad(port, 8);
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
  // FnetSocket.connect ソケット接続
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
        yield mkdirParents(cliDir);

        var cliDirWatchChan = chan();
        var cliDirWatch = fs.watch(cliDir, cliDirWatchChan);
        dirWatches[cliDir] = cliDirWatch; // ####
        console.log('creating... %s', getTermName(cliDir)); // ####

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

            var postfix = name.slice(-4);
            if (postfix === '.tmp') continue;

            var prefix = name.slice(0,4);
            var file = path.resolve(cliDir, name);

            // ack (connect request accepted) 接続要求受入れ完了
            if (prefix === 'ack_') {
              var contents = yield cofs.readFile(file);
              contents = String(contents);
              yield cofs.unlink(file);
              //soc.readStart();
              soc.writeStart(contents);
              soc.emit('connect');
              continue;
            }

            // data received データ受信
            if (prefix === 'dat_') {
              var contents = yield cofs.readFile(file);
              yield cofs.unlink(file);
              soc.$readBuffs.push(contents);
              soc.emit('readable');
              continue;
            }

            // end/close received 終了受信
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
        console.log(err.stack || err);
        // throw new err;
      } finally {
        delete dirWatches[cliDir]; // ####
        console.log('deleting... %s', getTermName(cliDir)); // ####
        yield sleep(FINISH_TIMEOUT);
        if (cliDirWatch) cliDirWatch.close();
        yield sleep(FINISH_TIMEOUT);
        yield rmdirRecursive(cliDir);

        if (soc.$remotePath) {
          var remotePath = path.resolve(config.dir, soc.$remotePath);
          if (dirWatches[remotePath] !== null) console.log('eh? remotePath is not null?');
          yield sleep(LONG_TIMEOUT); // ####
          delete dirWatches[remotePath]; // ####
          console.log('deleting... %s (1)', getTermName(remotePath)); // ####
          yield rmdirRecursive(remotePath);
        }
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
  // FnetSocket.write ソケット書込み
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
  // FnetSocket.end ソケット終了(クローズ)
  FnetSocket.prototype.end = FnetSocket_end;
  function FnetSocket_end(buff) {
    var soc = this;
    if (soc.$isClosed) return;
    if (buff) soc.$writeChan(buff);
    soc.$writeChan.close();
    soc.$isClosed = true;
  }

  //----------------------------------------------------------------------
  // FnetSocket.read ソケット読込み
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
      process.nextTick(function () { soc.emit('end'); }); // on -> emit BUG FIX!
      return null;
    }
    console.log('eh? soc.read error. buff type: %s', typeof buff);
    return null;
  }

  //----------------------------------------------------------------------
  // FnetSocket.readStart ソケット読込み開始
  FnetSocket.prototype.readStart = FnetSocket_readStart;
  function FnetSocket_readStart() {
    var soc = this;

    // new thread
    co(function*(){
      var cliDir = path.resolve(config.dir, soc.$socDir);

      try {
        yield mkdirParents(cliDir);

        var cliDirWatchChan = chan();
        var cliDirWatch = fs.watch(cliDir, cliDirWatchChan);
        dirWatches[cliDir] = cliDirWatch; // ####
        console.log('creating... %s', getTermName(cliDir)); // ####

        loop: for (;;) {
          yield cliDirWatchChan;
          if (soc.$reading) continue; // 連続起動防止
          soc.$reading = true;

          var names = yield cofs.readdir(cliDir);

          for (var i in names) {
            var name = names[i];

            var postfix = name.slice(-4);
            if (postfix === '.tmp') continue;

            var prefix = name.slice(0,4);
            var file = path.resolve(cliDir, name);

            // data received データ受信
            if (prefix === 'dat_') {
              var contents = yield cofs.readFile(file);
              yield cofs.unlink(file);
              soc.$readBuffs.push(contents);
              soc.emit('readable');
              continue;
            }

            // end/close received 終了受信
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
        delete dirWatches[cliDir]; // ####
        console.log('deleting... %s', getTermName(cliDir)); // ####
        yield sleep(FINISH_TIMEOUT);
        if (cliDirWatch) cliDirWatch.close();
        yield sleep(FINISH_TIMEOUT);
        yield rmdirRecursive(cliDir);

        if (soc.$remotePath) {
          var remotePath = path.resolve(config.dir, soc.$remotePath);
          if (dirWatches[remotePath] !== null) console.log('eh? remotePath is not null?');
          yield sleep(LONG_TIMEOUT); // ####
          delete dirWatches[remotePath]; // ####
          console.log('deleting... %s (2)', getTermName(remotePath)); // ####
          yield rmdirRecursive(remotePath);
        }
      }

    })();
  }

  //----------------------------------------------------------------------
  // FnetSocket.writeStart 書込み開始
  FnetSocket.prototype.writeStart = FnetSocket_writeStart;
  function FnetSocket_writeStart(remotePath) {
    var soc = this;
    soc.$remotePath = remotePath;
    dirWatches[path.resolve(config.dir, remotePath)] = null; // ####
    console.log('connect ... %s', remotePath); // ####

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

          // データ書込み
          var file = path.resolve(config.dir, soc.$remotePath, 'dat_' + pad(++soc.$writeSeq, 8));
          yield cofs.writeFile(file + '.tmp', buff);
          yield cofs.rename(file + '.tmp', file + '.txt');
        }
      } catch (err) {
        throw err;
      } finally {
        // 終了書込み
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

        var svrDirWatch = fs.watch(svrDir, svrDirWatchChan);
        dirWatches[svrDir] = svrDirWatch; // ####
        console.log('creating... %s', getTermName(svrDir)); // ####

        server.emit('listening');
        for (;;) {
          yield svrDirWatchChan;

          if (server.$reading) continue; // 連続起動防止
          server.$reading = true;

          var names = yield cofs.readdir(svrDir);

          for (var i in names) {
            var name = names[i];

            if (!(name in server.$connections)) {
              var postfix = name.slice(-4);
              if (postfix === '.tmp') continue;

              var prefix = name.slice(0,4);

              // connect request 接続要求
              if (prefix === 'con_') {
                var contents = yield cofs.readFile(path.resolve(svrDir, name));
                contents = String(contents);
                yield cofs.unlink(path.resolve(svrDir, name));

                var cli = new FnetSocket();
                var socDir = cli.$socDir;
                yield mkdirParents(path.resolve(config.dir, socDir));
                cli.readStart();
                server.$connections[socDir] = cli;
                var file = path.resolve(config.dir, contents, 'ack_' + cli.$no);
                yield cofs.writeFile(file + '.tmp', socDir);
                yield cofs.rename(file + '.tmp', file + '.txt');
                cli.writeStart(contents);
                server.emit('connection', cli);
                continue;
              }

            }
          } // for i in names

          server.$reading = false;

        } // for (;;)

        this.emit('listening');
      } catch (err) {
        throw err;
      } finally {
        delete dirWatches[svrDir]; // ####
        console.log('deleting... %s', getTermName(svrDir)); // ####
        yield sleep(FINISH_TIMEOUT);
        if (svrDirWatch) svrDirWatch.close();
        yield sleep(FINISH_TIMEOUT);
        yield rmdirRecursive(svrDir);
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
