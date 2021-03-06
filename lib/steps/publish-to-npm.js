/*
 * Copyright (c) 2015, Groupon, Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * Redistributions of source code must retain the above copyright notice,
 * this list of conditions and the following disclaimer.
 *
 * Redistributions in binary form must reproduce the above copyright
 * notice, this list of conditions and the following disclaimer in the
 * documentation and/or other materials provided with the distribution.
 *
 * Neither the name of GROUPON nor the names of its contributors may be
 * used to endorse or promote products derived from this software without
 * specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
 * IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
 * TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
 * PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
 * TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

'use strict';

const fs = require('fs');

const path = require('path');

const console = require('console');

const debug = require('debug')('nlm:publish-to-npm');

const run = require('../run');

function generateNpmrc(registryUrl) {
  const configUrl = registryUrl
    .replace(/^https?:/, '') // remove protocol prefix
    .replace(/([^/])$/, '$1/'); // make sure the url ends with /

  return [
    '; Generated by nlm',
    `registry=${registryUrl}`,
    '',
    '; For registries that support OAuth tokens',
    '; The remaining values will be ignored if NPM_TOKEN is set',
    `${configUrl}:_authToken=\${NPM_TOKEN}`,
    '',
    '; Old-style username/password integration',
    `${configUrl}:_password=\${NPM_PASSWORD_BASE64}`,
    `${configUrl}:username=\${NPM_USERNAME}`,
    `${configUrl}:email=\${NPM_EMAIL}`,
    '',
  ].join('\n');
}

function checkPublishRequired(cwd, pkg, options) {
  const { distTag } = options;

  if (!distTag || distTag === 'false') {
    return 'wrong-branch';
  }

  return run('npm', ['show', pkg.name, '--json'], {
    cwd,
    env: options.npmEnv,
  })
    .then(content => {
      // If we get an empty response, we'll assume it was not found.
      if (content.trim() === '') {
        return 'publish';
      }

      const registryState = JSON.parse(content);

      if (!registryState.versions.includes(pkg.version)) {
        return 'publish';
      }

      const distTagCurrent = registryState['dist-tags'][distTag];

      if (distTagCurrent !== pkg.version) {
        return 'dist-tag';
      }

      return 'none';
    })
    .catch(error => {
      if (error.message.includes('ERR! 404')) {
        return 'publish';
      }

      throw error;
    });
}

function deprecateIfNeeded(cwd, pkg, options) {
  if (options.deprecated == null) return Promise.resolve();
  return run('npm', ['deprecate', pkg.name, options.deprecated], {
    cwd,
    env: options.npmEnv,
  });
}

function getCurrentCommit(cwd) {
  return run('git', ['log', '--format=%s', '--max-count=1'], {
    cwd,
  }).then(s => s.trim());
}

function forwardToStdout(str) {
  process.stdout.write(str);
}

function doPublish(cwd, pkg, options) {
  if (!options.commit) {
    console.log('[nlm] Version %s needs publishing', pkg.version);
    return null;
  }

  return run('npm', ['publish', '--tag', options.distTag], {
    cwd,
    env: options.npmEnv,
  }).then(forwardToStdout);
}

function updateDistTag(cwd, pkg, options) {
  if (!options.commit) {
    console.log('[nlm] Set dist-tag %s to %s', options.distTag, pkg.version);
    return null;
  }

  return run(
    'npm',
    ['dist-tag', 'add', `${pkg.name}@${pkg.version}`, options.distTag],
    {
      cwd,
      env: options.npmEnv,
    }
  ).then(forwardToStdout);
}

function hasTokenAuth(env) {
  return !!env.NPM_TOKEN;
}

function hasBasicAuth(env) {
  return !!env.NPM_USERNAME && !!env.NPM_EMAIL && !!env.NPM_PASSWORD_BASE64;
}

function envify(camelCase) {
  return camelCase.replace(/[A-Z]/g, '_$&').toUpperCase();
}

function publishToNPM(cwd, pkg, options) {
  if (pkg.private) {
    debug('Skipping publish, package is set to private');
    return Promise.resolve();
  }

  options.npmEnv = { ...process.env };
  ['npmToken', 'npmPasswordBase64', 'npmUsername', 'npmEmail'].forEach(opt => {
    const envOpt = envify(opt);
    const cfgVal = options[opt];
    options.npmEnv[envOpt] =
      cfgVal != null ? cfgVal : options.npmEnv[envOpt] || '';
  });

  if (!hasTokenAuth(options.npmEnv) && !hasBasicAuth(options.npmEnv)) {
    debug('Skipping publish, no npm auth');
    return Promise.resolve();
  }

  const rcFile = path.join(cwd, '.npmrc');
  const rcContent = generateNpmrc(pkg.publishConfig.registry);
  options.npmEnv.npm_config_registry = pkg.publishConfig.registry;
  fs.writeFileSync(rcFile, rcContent);

  if (!options.commit) {
    debug('Skipping publish, no --commit');
    return Promise.resolve();
  }

  return Promise.all([
    checkPublishRequired(cwd, pkg, options),
    getCurrentCommit(cwd),
  ])
    .then(([publishRequired, currentCommit]) => {
      if (currentCommit !== `v${pkg.version}`) {
        console.log(
          '[nlm] Skipping publish, not a version commit:',
          currentCommit
        );
        return null;
      }

      switch (publishRequired) {
        case 'dist-tag':
          return updateDistTag(cwd, pkg, options);

        case 'publish':
          return doPublish(cwd, pkg, options);

        case 'wrong-branch':
          console.log(
            '[nlm] No release channel for branch %j',
            options.currentBranch
          );
          return null;

        default:
          console.log('[nlm] Version %s already exists', pkg.version);
          return null;
      }
    })
    .then(() => deprecateIfNeeded(cwd, pkg, options))
    .catch(err => {
      fs.unlinkSync(rcFile);
      throw err;
    })
    .then(() => {
      fs.unlinkSync(rcFile);
    });
}

module.exports = publishToNPM;
