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

const fs = require('fs');
const crypto = require('crypto');
const AWS = require('aws-sdk');
const through2 = require('through2');
const log = require('./log');
const utils = require('./utils');

const Storage = function (options) {
	this.tmpDir = options.tmpDir;
	if (this.tmpDir.slice(-1) !== '/') this.tmpDir += '/';
	
	this.s3Client = new AWS.S3(options.config);
};

module.exports = Storage;

/**
 * Returns s3 file stream
 * @param hash
 * @param zip
 * @param callback
 * @returns stream
 */
Storage.prototype.getStream = function (hash, zip, callback) {
	const storage = this;
	return utils.promisify(function (callback) {
		storage.getStreamByKey(hash, function (err, stream) {
			if (err) {
				if (err.code === 'NoSuchKey') {
					storage.getLegacyKey(hash, zip, function (err, key) {
						if (err) return callback(err);
						storage.getStreamByKey(key, function (err, stream) {
							if (err) return callback(err);
							callback(null, stream);
						});
					});
				} else {
					callback(err)
				}
			} else {
				callback(null, stream);
			}
		});
	}, callback);
};

/**
 * If stream data starts flowing this function returns stream object,
 * otherwise it returns error.
 * AWS S3 SDK only provides 'createReadStream' to transform request to stream,
 * and emits NoItem error to stream. But we need to know if item exists or not
 * before creating stream. There isn't convenient way to do this.
 * There also exists 'httpResponse.createUnbufferedStream' that can be used in
 * 'httpHeaders' event to create a stream if 200 http response code was get,
 * but this makes error handling more complicated and hacky
 * @param key
 * @param callback
 */
Storage.prototype.getStreamByKey = function(key, callback) {
	const storage = this;
	let streaming = false;
	let n =0;
	let stream2 = through2({highWaterMark: 1 * 1024 * 1024},
		function (chunk, enc, next) {
			if(!streaming) {
				streaming = true;
				callback(null, stream2);
			}
			this.push(chunk);
			next();
		});

	let stream = storage.s3Client.getObject({Key: key}).createReadStream();
	
	// There are errors that can happen before data started streaming
	// e.g. NoItemFound, connection time out, etc.
	// and there are errors that can happen when streaming is already started
	// e.g. connection reset, data timeout, etc.
	stream.on('error', function(err) {
		if (streaming) {
			stream2.emit('error', err);
		} else {
			callback(err);
		}
	});
	stream.pipe(stream2);
};

/**
 * Try to get legacy S3 key
 * @param hash
 * @param zip
 * @param callback
 */
Storage.prototype.getLegacyKey = function (hash, zip, callback) {
	const storage = this;
	const params = {
		Bucket: this.bucket,
		MaxKeys: 1,
		Prefix: hash + '/' + (zip ? 'c/' : ''),
	};
	storage.s3Client.listObjects(params, function (err, data) {
		if (err) return callback(err);
		if (Array.isArray(data.Contents) && data.Contents[0] && data.Contents[0].Key) {
			return callback(null, data.Contents[0].Key)
		}
		callback(new Error('No S3 key found'));
	});
};

Storage.prototype.getTmpPath = function () {
	try {
		return this.tmpDir + 'ztmp_' + crypto.randomBytes(16).toString('hex');
	} catch (err) {
		return null;
	}
};

Storage.prototype.downloadTmp = function (hash, zip, callback) {
	const storage = this;
	return utils.promisify(function (callback) {
		storage.getStream(hash, zip, function (err, s3Stream) {
			if (err) return callback(err);
			let tmpPath = storage.getTmpPath();
			if (!tmpPath) return callback(new Error('Error generating a tmp file path'));
			
			let tmpStream = fs.createWriteStream(tmpPath);
			
			// Multiple streams can theoretically simultaneously emit errors,
			// therefore we have to prevent repeated callback calls
			let _callback = function () {
				_callback = function () {
				};
				
				// Delete the temporary file if one or another stream fails
				fs.unlink(tmpPath, function (err) {
				});
				callback.apply(this, arguments);
			};
			
			tmpStream.on('error', function (err) {
				_callback(err)
			});
			s3Stream.on('error', function (err) {
				_callback(err)
			});
			
			tmpStream.on('finish', function () {
				callback(null, tmpPath);
			});
			
			s3Stream.pipe(tmpStream);
		});
	}, callback);
};
