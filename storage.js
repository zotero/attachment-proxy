/*
 ***** BEGIN LICENSE BLOCK *****
 
 This file is part of the Zotero Data Server.
 
 Copyright © 2018 Center for History and New Media
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

const fs = require('fs');
const crypto = require('crypto');
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { pipeline } = require('stream/promises');
const log = require('./log');

const Storage = function (options) {
	this.tmpDir = options.tmpDir;
	if (this.tmpDir.slice(-1) !== '/') this.tmpDir += '/';
	
	this.bucket = options.config.bucket;
	this.s3Client = new S3Client({
		region: options.config.region
	});
};

module.exports = Storage;

/**
 * Returns s3 file stream
 * @param hash
 * @returns stream
 */
Storage.prototype.getStream = async function (hash) {
	try {
		return await this.getStreamByKey(hash);
	}
	catch (e) {
		if (e.code == 'NoSuchKey') {
			let legacyKey = await this.getLegacyKey(hash);
			return await this.getStreamByKey(legacyKey);
		}
		throw e;
	}
};

/**
 * @param key
 */
Storage.prototype.getStreamByKey = async function(key) {
	let { Body, ContentLength } = await this.s3Client.send(
		new GetObjectCommand({
			Bucket: this.bucket,
			Key: key
		})
	);
	Body.contentLength = ContentLength;
	return Body;
};

/**
 * Try to get legacy S3 key
 * @param hash
 */
Storage.prototype.getLegacyKey = async function (hash) {
	const params = {
		Bucket: this.bucket,
		MaxKeys: 1,
		Prefix: hash,
	};
	const { Contents } = await this.s3Client.send(
		new ListObjectsV2Command(params)
	);
	
	if (!Contents?.length) {
		const err = new Error('No legacy key found');
		err.code = 'NoSuchKey';
		throw err;
	}
	return Contents[0].Key;
};

Storage.prototype.getTmpPath = function () {
	try {
		return this.tmpDir + 'ztmp_' + crypto.randomBytes(16).toString('hex');
	} catch (err) {
		return null;
	}
};

Storage.prototype.downloadTmp = async function (hash) {
	let tmpPath = this.getTmpPath();
	try {
		let s3Stream = await this.getStream(hash);
		let tmpStream = fs.createWriteStream(tmpPath);
		await pipeline(s3Stream, tmpStream);
		return tmpPath;
	}
	catch (e) {
		try { await fs.promises.unlink(tmpPath); } catch (_) {}
		throw e;
	}
};
