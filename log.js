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

const { createLogger, transports, format } = require('winston');
const config = require('config');

const log = createLogger({
	format: format.combine(
		format.timestamp(),
		format.errors({ stack: true }),     // moves err.stack onto info.stack
		format.printf(info => {
			// Pretty-print everything on one line
			const { level, message, ...meta } = info;
			const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
			return `[${level}] ${message}${metaStr}`;
		})
	)
});

if (config.get('logFile')) {
	log.add(new transports.File({
		level: config.get('logLevel'),
		filename: config.get('logFile'),
	}));
} else {
	log.add(new transports.Console({
		level: config.get('logLevel'),
	}));
}

module.exports = log;
