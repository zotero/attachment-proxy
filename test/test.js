/*
 ***** BEGIN LICENSE BLOCK *****
 
 This file is part of the Zotero Data Server.
 
 Copyright © 2017 Center for History and New Media
 George Mason University, Fairfax, Virginia, USA
 http://zotero.org
 
 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU Affero General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.
 
 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU Affero General Public License for more details.
 
 You should have received a copy of the GNU Affero General Public License
 along with this program.  If not, see <http://www.gnu.org/licenses/>.
 
 ***** END LICENSE BLOCK *****
 */

const expect = require('chai').expect;
const crypto = require('crypto');
const AWS = require('aws-sdk');
const archiver = require('archiver');
const config = require('config');
// resolveWithFullResponse: true - return full 'res' object instead of 'body'
// simple: false - don't throw on not 200 responses
const request = require('request-promise-native')
	.defaults({resolveWithFullResponse: true, simple: false});

const s3 = new AWS.S3(config.get('s3'));

function getSignedURL(payload, filename) {
	payload = JSON.stringify(payload);
	payload = new Buffer(payload).toString('base64');
	let signature = crypto.createHmac('sha256', config.get('secret')).update(payload).digest('hex');
	return 'http://localhost:' + config.get('port') + '/' + encodeURIComponent(payload) + '/' + signature + '/' + encodeURIComponent(filename);
}

function uploadFile(key, body) {
	let params = {
		Key: key,
		Body: body
	};
	return s3.upload(params).promise();
}

function deleteFile(key) {
	let params = {
		Key: key
	};
	return s3.deleteObject(params).promise();
}

function generateHash() {
	return crypto.randomBytes(16).toString('hex');
}

let hashFile;
let hashZip;
let hashFileLegacy;
let hashZipLegacy;

describe('Attachment proxy', function () {
	before(async function () {
		this.timeout(0);
		await require('../server')();
		
		hashFile = generateHash();
		await uploadFile(hashFile, 'content');
		
		let zip = archiver('zip');
		zip.append('content', {name: 'document.htm'});
		zip.append('content', {name: 'QWJjZGVmZyDDg8KCw4PCqcODwqzDg8K4w4PCvCDDqMK/wpnDpsKYwq/DpMK4woDDpMK4wqrDpsK1wovDqMKvwpXDo8KAwoI=%ZB64'});
		zip.append('content', {name: 'image.jpg'});
		zip.append('content', {name: 'directory/file.txt'});
		zip.finalize();
		hashZip = generateHash();
		await uploadFile(hashZip, zip);
		
		hashFileLegacy = generateHash() + '/file.pdf';
		await uploadFile(hashFileLegacy, 'content');
		
		zip = archiver('zip');
		zip.append('content', {name: 'document.htm'});
		zip.finalize();
		hashZipLegacy = generateHash() + '/c/WQP64GX4.zip';
		await uploadFile(hashZipLegacy, zip);
	});
	
	it('should download a file', async function () {
		let url = getSignedURL({
			hash: hashFile,
			expires: Math.floor(Date.now() / 1000) + 10,
			filename: 'file'
		}, 'file');
		let res = await request(url);
		expect(res.statusCode).to.equal(200);
		expect(res.body).to.equal('content');
	});
	
	it('should fallback to a legacy S3 regular key', async function () {
		let url = getSignedURL({
			hash: hashFileLegacy,
			expires: Math.floor(Date.now() / 1000) + 10,
			filename: 'file'
		}, 'file');
		let res = await request(url);
		expect(res.statusCode).to.equal(200);
		expect(res.body).to.equal('content');
	});
	
	it('should fallback to a legacy s3 zip key', async function () {
		let url = getSignedURL({
			hash: hashZipLegacy,
			expires: Math.floor(Date.now() / 1000) + 10,
			zip: 1
		}, 'document.htm');
		let res = await request(url);
		expect(res.statusCode).to.equal(200);
		expect(res.body).to.equal('content');
	});
	
	it('should only allow filename that is in payload', async function () {
		let url = getSignedURL({
			hash: hashFileLegacy,
			expires: Math.floor(Date.now() / 1000) + 10,
			filename: 'file1.pdf'
		}, 'file2.pdf');
		let res = await request(url);
		expect(res.statusCode).to.equal(404);
	});
	
	it('should download a file from a zip', async function () {
		let url = getSignedURL({
			hash: hashZip,
			expires: Math.floor(Date.now() / 1000) + 10,
			zip: 1
		}, 'document.htm');
		let res = await request(url);
		expect(res.statusCode).to.equal(200);
		expect(res.body).to.equal('content');
	});
	
	it('should guess the mime type for files in a zip', async function () {
		let url = getSignedURL({
			hash: hashZip,
			expires: Math.floor(Date.now() / 1000) + 10,
			zip: 1
		}, 'image.jpg');
		let res = await request(url);
		expect(res.statusCode).to.equal(200);
		expect(res.headers['content-type']).to.equal('image/jpeg');
		expect(res.body).to.equal('content');
	});
	
	it('should download a file with a legacy filename from a zip', async function () {
		let decoded = 'Abcdefg Âéìøü 这是一个测试。';
		let url = getSignedURL({
			hash: hashZip,
			expires: Math.floor(Date.now() / 1000) + 10,
			zip: 1
		}, decoded);
		let res = await request(url);
		expect(res.statusCode).to.equal(200);
		expect(res.body).to.equal('content');
	});
	
	it('should allow to set a custom content-type', async function () {
		let url = getSignedURL({
			hash: hashFile,
			expires: Math.floor(Date.now() / 1000) + 10,
			contentType: 'image/png',
			filename: 'file'
		}, 'file');
		let res = await request(url);
		expect(res.statusCode).to.equal(200);
		expect(res.headers['content-type']).to.equal('image/png');
		expect(res.body).to.equal('content');
	});
	
	it('should allow to set a custom content-type and charset', async function () {
		let url = getSignedURL({
			hash: hashFile,
			expires: Math.floor(Date.now() / 1000) + 10,
			contentType: 'text/html',
			charset: 'chinese',
			filename: 'file'
		}, 'file');
		let res = await request(url);
		expect(res.statusCode).to.equal(200);
		expect(res.headers['content-type']).to.equal('text/html; charset=chinese');
		expect(res.body).to.equal('content');
	});
	
	it('should use gzip for text files', async function () {
		let url = getSignedURL({
			hash: hashFile,
			expires: Math.floor(Date.now() / 1000) + 10,
			contentType: 'text/html',
			filename: 'file'
		}, 'file');
		let res = await request({url: url, gzip: true});
		expect(res.statusCode).to.equal(200);
		expect(res.headers['content-encoding']).to.equal('gzip');
		expect(res.body).to.equal('content');
	});
	
	it('should not allow undefined url expiration', async function () {
		let url = getSignedURL({
			hash: hashFile,
			filename: 'file'
		}, 'file');
		let res = await request(url);
		expect(res.statusCode).to.equal(500);
	});
	
	it('should not allow undefined hash', async function () {
		let url = getSignedURL({
			expires: Math.floor(Date.now() / 1000) + 10,
			filename: 'file'
		}, 'file');
		let res = await request(url);
		expect(res.statusCode).to.equal(500);
	});
	
	it('should not allow expired url', async function () {
		let url = getSignedURL({
			hash: hashFile,
			expires: Math.floor(Date.now() / 1000) - 1,
			filename: 'file'
		}, 'file');
		let res = await request(url);
		expect(res.statusCode).to.equal(410);
	});
	
	it('should download a file from a directory in a zip', async function () {
		let url = getSignedURL({
			hash: hashZip,
			expires: Math.floor(Date.now() / 1000) + 10,
			zip: 1
		}, 'directory/file.txt');
		let res = await request(url);
		expect(res.statusCode).to.equal(200);
		expect(res.body).to.equal('content');
	});
	
	after(async function () {
		this.timeout(0);
		await deleteFile(hashFile);
		await deleteFile(hashZip);
		await deleteFile(hashFileLegacy);
		await deleteFile(hashZipLegacy);
	});
});
