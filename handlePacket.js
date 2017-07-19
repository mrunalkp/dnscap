var path = require('path');
var amqp = require('amqplib/callback_api');
var express = require('express');
var pcap = require("pcap");
var async = require('async');
var DNS = require("./pcap/decode/dns.js"); // Local Copy of nodejs pcap modified for dns packet decoding to work properly
var SysLogger = require('ain2');
var Cryptr = require('cryptr'),
    cryptr = new Cryptr(config.encryption_string,'aes-128-ctr');
var os = require('os');
var logger = new SysLogger();
var Memcached = require('memcached');
var memcached = new Memcached("127.0.0.1:11211");

var clean_packet = function (host, status, hashed_src, ips) {
  this.host = host;
  this.status = status;
  if(hashed_src != undefined)
    this.hashed_src = hashed_src;
  this.ips = ips;
  if(ips.length != 0)
    this.ip = ips[0];
};

var addToDictionary = function (Dictionary, nextPacket, value) {
  value = parseInt(value);
  var key = JSON.stringify(nextPacket);
  Dictionary[key] = (Dictionary[key]+value) || value;
};

var responseToString = function (responseCode) {
  try {
    return {
      0: "OK",
      1: "FORMAT ERR",
      2: "SERVER ERR",
      3: "NXDOMAIN ERR",
      4: "UNSUPPORTED ERR",
      5: "REFUSED ERR"
    }[responseCode];
  } catch(err) {
    logger.log("Unable to determine response code for " + responseCode)
    return "CODE " + responseCode;
  }
};

var sanitizePacket = function (packet) {
  var packetData = packet.payload.payload.payload.data;
  var answer_rrs;
  var question_rrs;
  var ipSet = [];
  try {
    if(packetData != undefined) {
      var decodedPacket = new DNS().decode(packetData, 0);
      answer_rrs = decodedPacket.answer.rrs;
      question_rrs = decodedPacket.question.rrs;
      var packetStatus;
      var properResponse = false;
      if(decodedPacket.ancount > 0) {
        properResponse = answer_rrs.some(function (element, index, array) {
          return element.type == 1;
        });
      }
      if(!properResponse) {
        if(question_rrs[0].type != 1 /* A record */ )
          return;
        if(decodedPacket.header.responseCode == 0)
          console.log(decodedPacket.question.rrs[0].toString());
      }
      for(var i = 0; i < answer_rrs.length; i++) {
        if(answer_rrs[i].rdata != null) {
          ipSet.push(answer_rrs[i].rdata.toString());
        }
      }
    }
    packetStatus = responseToString(decodedPacket.header.responseCode);
    var hashed_src = undefined;
    if(config.encrypt) { // should move inside sanitizePacket
      memcached.get(packet.payload.payload.daddr, function (err, data) {
        if(data != undefined)
          hashed_src = data;
        else {
          hashed_src = cryptr.encrypt(packet.payload.payload.daddr + packet.payload.payload.dhost + config.encryption_string);
          memcached.set(packet.payload.payload.daddr, hashed_src, function (err) {
            logger.error(err);
          });
        }
        return new clean_packet(decodedPacket.question.rrs[0].name, packetStatus, hashed_src, ipSet);
      });
    }
    else {
      return new clean_packet(decodedPacket.question.rrs[0].name, packetStatus, hashed_src, ipSet);
    }
  } catch(err) {
    logger.error(err);
    return undefined;
  }
};

var stats = {
  totalRequests: 0,
  recentRequests: 0,
  cpuUsage: 0,
  freeMemory: 0
};
var packetSet = {};
var currentInterval = 0;
var connectionChannel;
var app = express();

app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname + '/graph.html'));
});

app.get('/update', function (req, res) {
  stats.recentRequests = Object.keys(packetSet).length;
  res.json(stats);
});

app.listen(3000, 'localhost', function () {
  console.log('Listening on port 3000!');
});

amqp.connect("amqp://rabbitmqadmin:rabbitmqadmin@" + config.rabbit_master_ip, function (err, conn) {
  conn.createChannel(function (err, ch) {
    connectionChannel = ch;
  });
});

var cargo = async.cargo(function (data, cb) {
  connectionChannel.sendToQueue('dnscap-q', new Buffer(JSON.stringify(data)));
   return cb();
}, config.CARGO_ASYNC);

var handlePacket = function (raw_packet) {
  var interval = Math.trunc(new Date().getTime() / config.intervalTimer) * config.intervalTimer;
  if(currentInterval != interval) {
    currentInterval = interval;
    var setRef = packetSet;
    packetSet = {};
    Object.keys(setRef).forEach(function (packet) {
      var msg = {};
      msg['date'] = interval;
      msg[packet] = setRef[packet];
      cargo.push(msg);
    });
  }
  try {
    var packet = pcap.decode.packet(raw_packet);
    var hashed_src;
    var sanitizedPacket = sanitizePacket(packet);
    if(sanitizedPacket == undefined)
      return;
    addToDictionary(packetSet, sanitizedPacket, 1);
    stats.totalRequests++;
    stats.cpuUsage = (os.loadavg()[0]) / os.cpus().length;
    stats.freeMemory = os.freemem();
  } catch (e) {
    // count errors
    var errString = "Error Occurred : " + e + " Packet: " + packet;
    if(sanitizedPacket != undefined)
      errString += sanitizedPacket;
    logger.err(errString);
  }
}

var pcap_session = pcap.createSession('eno2', 'ip proto 17 and src port 53');
pcap_session.on('packet', handlePacket);
/*var pcap_session = [];
for(var i = 1; i < 4; i++) {
  pcap_session[i-1] = pcap.createSession("eno" + i, "ip proto 17 and src port 53");
  pcap_session[i-1].on('packet', handlePacket);
} */
