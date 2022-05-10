import Bourne from '@hapi/bourne';

/**
 * A list if keys to ignore when parsing.
 *
 * @type {string[]}
 */
const blacklist = [ '__proto__', 'constructor', 'prototype' ];

/**
 * Parses the query/search or fragment/hash parameters out of a specific URL and
 * returns them as a JS object.
 *
 * @param {URL} url - The URL to parse.
 * @param {boolean} dontParse - If falsy, some transformations (for parsing the
 * value as JSON) will be executed.
 * @param {string} source - If {@code 'search'}, the parameters will parsed out
 * of {@code url.search}; otherwise, out of {@code url.hash}.
 * @returns {Object}
 */
export function parseURLParams(
        url,
        dontParse = false,
        source = 'hash') {
    const paramStr = source === 'search' ? url.search : url.hash;
    const params = {};
    const paramParts = (paramStr && paramStr.substr(1).split('&')) || [];

    // Detect and ignore hash params for hash routers.
    if (source === 'hash' && paramParts.length === 1) {
        const firstParam = paramParts[0];

        if (firstParam.startsWith('/') && firstParam.split('&').length === 1) {
            return params;
        }
    }

    paramParts.forEach(part => {
        const param = part.split('=');
        const key = param[0];

        if (!key || key.split('.').some(k => blacklist.includes(k))) {
            return;
        }

        let value;

        try {
            value = param[1];

            if (!dontParse) {
                const decoded = decodeURIComponent(value).replace(/\\&/, '&');

                value = decoded === 'undefined' ? undefined : Bourne.parse(decoded);
            }
        } catch (e) {
            console.error(
                e, `Failed to parse URL parameter value: ${String(value)}`);

            return;
        }
        params[key] = value;
    });

    return params;
}
