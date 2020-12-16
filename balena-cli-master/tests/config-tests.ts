/**
 * @license
 * Copyright 2020 Balena Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { set as setEsVersion } from '@balena/es-version';
// Set the desired es version for downstream modules that support it
setEsVersion('es2018');

import * as tmp from 'tmp';
tmp.setGracefulCleanup();
// Use a temporary dir for tests data
process.env.BALENARC_DATA_DIRECTORY = tmp.dirSync().name;

import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 35; // it appears that 'nock' adds a bunch of listeners - bug?
// SL: Looks like it's not nock causing this, as have seen the problem triggered from help.spec,
//     which is not using nock.  Perhaps mocha/chai? (unlikely), or something in the CLI?

import { config as chaiCfg } from 'chai';
chaiCfg.showDiff = true;
// enable diff comparison of large objects / arrays
chaiCfg.truncateThreshold = 0;
