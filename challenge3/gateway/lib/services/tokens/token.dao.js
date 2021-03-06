'use strict';

let Promise = require('bluebird');
let db = require('../../db')();
let config = require('../../config');

let dao = {};

let redisNamespace = config.systemConfig.db.redis.namespace;

const accessTokenNamespace = 'access-token';
const accessTokenConsumerTokensNamespace = 'consumer-access-tokens';
const accessTokenConsumerTokensExpiredNamespace = 'consumer-access-tokens-expired';

const refreshTokenNamespace = 'refresh-token';
const refreshTokenConsumerTokensNamespace = 'consumer-refresh-tokens';
const refreshTokenConsumerTokensExpiredNamespace = 'consumer-refresh-tokens-expired';

dao.save = function (token, options) {
  options = options || {};

  let type = options.type || 'access_token';
  let tokenKey, consumerTokensKey;

  if (type === 'access_token') {
    // key for the token hash table
    tokenKey = redisNamespace.concat('-', accessTokenNamespace).concat(':', token.id);

    // key for the consumer-tokens hash table
    consumerTokensKey = redisNamespace.concat('-', accessTokenConsumerTokensNamespace).concat(':', token.consumerId);
  } else {
    tokenKey = redisNamespace.concat('-', refreshTokenNamespace).concat(':', token.id);
    consumerTokensKey = redisNamespace.concat('-', refreshTokenConsumerTokensNamespace).concat(':', token.consumerId);
  }

  return db
    .multi()
    .hmset(tokenKey, token)
    .hset(consumerTokensKey, token.id, token.expiresAt)
    .execAsync();
};

dao.find = function (tokenObj, options) {
  options = options || {};
  let foundToken, tokenNamespace, consumerTokensKey, consumerTokensExpiredKey;
  let type = options.type || 'access_token';

  if (type === 'access_token') {
    tokenNamespace = redisNamespace.concat('-', accessTokenNamespace);
    consumerTokensKey = redisNamespace.concat('-', accessTokenConsumerTokensNamespace).concat(':', tokenObj.consumerId);
    consumerTokensExpiredKey = redisNamespace.concat('-', accessTokenConsumerTokensExpiredNamespace).concat(':', tokenObj.consumerId);
  } else {
    tokenNamespace = redisNamespace.concat('-', refreshTokenNamespace);
    consumerTokensKey = redisNamespace.concat('-', refreshTokenConsumerTokensNamespace).concat(':', tokenObj.consumerId);
    consumerTokensExpiredKey = redisNamespace.concat('-', refreshTokenConsumerTokensExpiredNamespace).concat(':', tokenObj.consumerId);
  }

  return db.hgetallAsync(consumerTokensKey)
    .then((tokenIds) => {
      let tokenPromises, activeTokenIds, getTokenPromise;
      let expiredTokenIds = [];

      if (!tokenIds || Object.keys(tokenIds).length === 0) {
        return null;
      }

      activeTokenIds = Object.keys(tokenIds).filter((key) => {
        if (tokenIds[key] <= Date.now()) {
          expiredTokenIds.push(key);
          return false;
        }
        return true;
      });

      tokenPromises = activeTokenIds.map((id) => {
        return db.hgetallAsync(tokenNamespace.concat(':', id))
          .then((token) => {
            let isEqual;

            if (!token) {
              return Promise.reject(new Error());
            }

            isEqual = Object.keys(tokenObj).every((key) => tokenObj[key] === token[key]);
            return isEqual ? token : Promise.reject(new Error());
          });
      });

      if (tokenPromises.length === 0) {
        getTokenPromise = Promise.resolve(null);
      } else getTokenPromise = Promise.some(tokenPromises, 1);

      return getTokenPromise
        .then((token) => {
          foundToken = token[0];
        })
        .catch(() => null)
        .then(() => {
          let tokenTransaction = db.multi();

          if (expiredTokenIds.length === 0) {
            return;
          }

          expiredTokenIds.forEach((id) => {
            tokenTransaction = tokenTransaction.hset(tokenNamespace.concat(':', id), 'archived', 'true');
            tokenTransaction = tokenTransaction.hdel(consumerTokensKey, id);
            tokenTransaction = tokenTransaction.hset(consumerTokensExpiredKey, id, 'true');
          });

          return tokenTransaction.execAsync();
        })
        .then(() => foundToken);
    });
};

dao.get = function (tokenId, options) {
  options = options || {};
  let tokenNamespace, consumerTokensNamespace, consumerTokensExpiredNamespace;
  let type = options.type || 'access_token';

  if (type === 'access_token') {
    tokenNamespace = redisNamespace.concat('-', accessTokenNamespace);
    consumerTokensNamespace = redisNamespace.concat('-', accessTokenConsumerTokensNamespace);
    consumerTokensExpiredNamespace = redisNamespace.concat('-', accessTokenConsumerTokensExpiredNamespace);
  } else {
    tokenNamespace = redisNamespace.concat('-', refreshTokenNamespace);
    consumerTokensNamespace = redisNamespace.concat('-', refreshTokenConsumerTokensNamespace);
    consumerTokensExpiredNamespace = redisNamespace.concat('-', refreshTokenConsumerTokensExpiredNamespace);
  }

  return db.hgetallAsync(tokenNamespace.concat(':', tokenId))
    .then(token => {
      if (!token) {
        return null;
      }

      if (token.expiresAt > Date.now()) {
        return token;
      }

      if (token.archived) {
        if (options.includeExpired) {
          return token;
        } else return null;
      }

      return db
        .multi()
        .hset(tokenNamespace.concat(':', token.id), 'archived', 'true')
        .hdel(consumerTokensNamespace.concat(':', token.consumerId), token.id)
        .hset(consumerTokensExpiredNamespace.concat(':', token.consumerId), token.id, 'true')
        .execAsync()
        .then(() => {
          if (options.includeExpired) {
            return token;
          } else return null;
        });
    });
};

dao.getTokensByConsumer = function (id, options) {
  options = options || {};
  let consumerTokensNamespace, consumerTokensExpiredNamespace;
  let type = options.type || 'access_token';

  if (type === 'access_token') {
    consumerTokensNamespace = redisNamespace.concat('-', accessTokenConsumerTokensNamespace);
    consumerTokensExpiredNamespace = redisNamespace.concat('-', accessTokenConsumerTokensExpiredNamespace);
  } else {
    consumerTokensNamespace = redisNamespace.concat('-', refreshTokenConsumerTokensNamespace);
    consumerTokensExpiredNamespace = redisNamespace.concat('-', refreshTokenConsumerTokensExpiredNamespace);
  }

  let getIds = db.multi().hgetall(consumerTokensNamespace.concat(':', id));

  if (options.includeExpired) {
    getIds = getIds.hgetall(consumerTokensExpiredNamespace.concat(':', id));
  }

  return getIds
    .execAsync()
    .then((tokensArr) => {
      let tokens = tokensArr[0];
      let expiredTokens = tokensArr[1];

      let tokenPromises = [];

      if (!tokens && !expiredTokens) {
        return null;
      }

      tokens = Object.keys(tokens || {});
      expiredTokens = Object.keys(expiredTokens || {});

      tokens.concat(expiredTokens).forEach(tokenId => {
        return tokenPromises.push(this.get(tokenId, options));
      });

      return Promise.all(tokenPromises)
        .then(results => {
          return results.filter(r => !!r);
        });
    });
};

module.exports = dao;
