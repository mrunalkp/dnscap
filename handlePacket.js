var path = require('path');
var amqp = require('amqplib/callback_api');
var express = require('express');
var packets = require('./packet.js');
var pcap1 = require("pcap");
var async = require('async');

const app = express();
const intervalTimer = 2000;
const rabbit_master_ip = "130.245.169.67";
const initTime = new Date().getTime();
const CARGO_ASYNC = 20000;

var stats = {
	totalRequests: 0,
	recentRequests: 0,
};
var packetSet = {};
var currentInterval = 0;
var connectionChannel;

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname + '/graph.html'));
});

app.get('/update', function (req, res) {
	stats.recentRequests = Object.keys(packetSet).length;
    res.json(stats);
});

app.listen(3000,'localhost', function () {
	console.log('Listening on port 3000!')
});

amqp.connect("amqp://rabbitmqadmin:rabbitmqadmin@" + rabbit_master_ip, function (err, conn) {
    conn.createChannel(function (err, ch) {
    	connectionChannel = ch;
	});
});

var cargo = async.cargo(function (data, cb) {
	connectionChannel.sendToQueue('dnscap-q', new Buffer(JSON.stringify(data)));
	return cb();
}, CARGO_ASYNC);


var pcap_session1 = pcap1.createSession("eno2", "ip proto 17 and src port 53");
pcap_session1.on('packet', function (raw_packet) {
	var interval = Math.trunc((new Date().getTime()- initTime)/intervalTimer);
	if(currentInterval != interval) {
		currentInterval = interval;
		var setRef = packetSet;
    	packetSet = {};
    	var timeStamp = initTime + (interval * intervalTimer);
    	Object.keys(setRef).forEach(function (packet) {
    		var msg = {
    			date: timeStamp
    		};
    		msg[packet] = setRef[packet];
    		cargo.push(msg);
    	});
	}

    var packet = pcap1.decode.packet(raw_packet);
    var nextPacket = packets.sanitizePacket(packet);
    if(nextPacket == undefined)
    	return;
    packets.addToDictionary(packetSet,nextPacket,1);
    stats.totalRequests++;
});