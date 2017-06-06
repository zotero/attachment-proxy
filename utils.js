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

/**
 * Wraps another function and converts to promise,
 * if callback not set
 * @param fn the actual function to wrap
 * @param callback optional callback
 * @returns Promise|undefined
 */
exports.promisify = function(fn, callback) {
	if (callback) {
		fn(callback)
	} else {
		return new Promise(function (resolve, reject) {
			fn(function (err, res) {
				if (err) {
					reject(err)
				} else {
					resolve(res)
				}
			})
		})
	}
};
