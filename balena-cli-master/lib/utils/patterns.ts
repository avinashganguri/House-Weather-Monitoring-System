/*
Copyright 2016-2020 Balena Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import type * as BalenaSdk from 'balena-sdk';
import _ = require('lodash');

import {
	exitWithExpectedError,
	instanceOf,
	NotLoggedInError,
	ExpectedError,
} from '../errors';
import { getBalenaSdk, getVisuals, stripIndent, getCliForm } from './lazy';
import validation = require('./validation');
import { delay } from './helpers';
import { isV13 } from './version';
import { Organization } from 'balena-sdk';

export function authenticate(options: {}): Promise<void> {
	const balena = getBalenaSdk();
	return getCliForm()
		.run(
			[
				{
					message: 'Email:',
					name: 'email',
					type: 'input',
					validate: validation.validateEmail,
				},
				{
					message: 'Password:',
					name: 'password',
					type: 'password',
				},
			],
			{ override: options },
		)
		.then(balena.auth.login)
		.then(balena.auth.twoFactor.isPassed)
		.then((isTwoFactorAuthPassed: boolean) => {
			if (isTwoFactorAuthPassed) {
				return;
			}

			return getCliForm()
				.ask({
					message: 'Two factor auth challenge:',
					name: 'code',
					type: 'input',
				})
				.then(balena.auth.twoFactor.challenge)
				.catch((error: any) => {
					return balena.auth.logout().then(() => {
						if (
							error.name === 'BalenaRequestError' &&
							error.statusCode === 401
						) {
							throw new ExpectedError('Invalid two factor authentication code');
						}
						throw error;
					});
				});
		});
}

/**
 * Check if logged in, and throw `NotLoggedInError` if not.
 * Note: `NotLoggedInError` is an `ExpectedError`.
 */
export async function checkLoggedIn(): Promise<void> {
	const balena = getBalenaSdk();
	if (!(await balena.auth.isLoggedIn())) {
		throw new NotLoggedInError(stripIndent`
		Login required: use the “balena login” command to log in.
		`);
	}
}

export function askLoginType() {
	return getCliForm().ask<'web' | 'credentials' | 'token' | 'register'>({
		message: 'How would you like to login?',
		name: 'loginType',
		type: 'list',
		choices: [
			{
				name: 'Web authorization (recommended)',
				value: 'web',
			},
			{
				name: 'Credentials',
				value: 'credentials',
			},
			{
				name: 'Authentication token',
				value: 'token',
			},
			{
				name: "I don't have a balena account!",
				value: 'register',
			},
		],
	});
}

export function selectDeviceType() {
	return getBalenaSdk()
		.models.config.getDeviceTypes()
		.then((deviceTypes) => {
			deviceTypes = _.sortBy(deviceTypes, 'name').filter(
				(dt) => dt.state !== 'DISCONTINUED',
			);
			return getCliForm().ask({
				message: 'Device Type',
				type: 'list',
				choices: _.map(deviceTypes, ({ slug: value, name }) => ({
					name,
					value,
				})),
			});
		});
}

/**
 * Display interactive confirmation prompt.
 * If the user declines, then either an error will be thrown,
 * or `exitWithExpectedError` will be called (if exitIfDeclined true).
 * @param yesOption - automatically confirm if true
 * @param message - message to display with prompt
 * @param yesMessage - message to display if automatically confirming
 * @param exitIfDeclined - exitWithExpectedError when decline if true
 */
export async function confirm(
	yesOption: boolean,
	message: string,
	yesMessage?: string,
	exitIfDeclined = false,
) {
	if (yesOption) {
		if (yesMessage) {
			if (isV13()) {
				console.error(yesMessage);
			} else {
				console.log(yesMessage);
			}
		}
		return;
	}

	const confirmed = await getCliForm().ask<boolean>({
		message,
		type: 'confirm',
		default: false,
	});

	if (!confirmed) {
		const err = new ExpectedError('Aborted');
		// TODO remove this deprecated function (exitWithExpectedError)
		if (exitIfDeclined) {
			exitWithExpectedError(err);
		}
		throw err;
	}
}

export function selectApplication(
	filter?: (app: ApplicationWithDeviceType) => boolean,
	errorOnEmptySelection = false,
) {
	const balena = getBalenaSdk();
	return balena.models.application
		.hasAny()
		.then(async (hasAnyApplications) => {
			if (!hasAnyApplications) {
				throw new ExpectedError("You don't have any applications");
			}

			const apps = (await balena.models.application.getAll({
				$expand: {
					is_for__device_type: {
						$select: 'slug',
					},
				},
			})) as ApplicationWithDeviceType[];
			return apps.filter(filter || _.constant(true));
		})
		.then((applications) => {
			if (errorOnEmptySelection && applications.length === 0) {
				throw new ExpectedError('No suitable applications found for selection');
			}
			return getCliForm().ask({
				message: 'Select an application',
				type: 'list',
				choices: _.map(applications, (application) => ({
					name: `${application.app_name} (${application.slug}) [${application.is_for__device_type[0].slug}]`,
					value: application,
				})),
			});
		});
}

export async function selectOrganization(organizations?: Organization[]) {
	// Use either provided orgs (if e.g. already loaded) or load from cloud
	organizations =
		organizations || (await getBalenaSdk().models.organization.getAll());
	return getCliForm().ask({
		message: 'Select an organization',
		type: 'list',
		choices: organizations.map((org) => ({
			name: `${org.name} (${org.handle})`,
			value: org.handle,
		})),
	});
}

export async function awaitDevice(uuid: string) {
	const balena = getBalenaSdk();
	const deviceName = await balena.models.device.getName(uuid);
	const visuals = getVisuals();
	const spinner = new visuals.Spinner(
		`Waiting for ${deviceName} to come online`,
	);

	const poll = async (): Promise<void> => {
		const isOnline = await balena.models.device.isOnline(uuid);
		if (isOnline) {
			spinner.stop();
			console.info(`The device **${deviceName}** is online!`);
			return;
		} else {
			// Spinner implementation is smart enough to
			// not start again if it was already started
			spinner.start();

			await delay(3000);
			await poll();
		}
	};

	console.info(`Waiting for ${deviceName} to connect to balena...`);
	await poll();
	return uuid;
}

export async function awaitDeviceOsUpdate(
	uuid: string,
	targetOsVersion: string,
) {
	const balena = getBalenaSdk();

	const deviceName = await balena.models.device.getName(uuid);
	const visuals = getVisuals();
	const progressBar = new visuals.Progress(
		`Updating the OS of ${deviceName} to v${targetOsVersion}`,
	);
	progressBar.update({ percentage: 0 });

	const poll = async (): Promise<void> => {
		const [
			osUpdateStatus,
			{ overall_progress: osUpdateProgress },
		] = await Promise.all([
			balena.models.device.getOsUpdateStatus(uuid),
			balena.models.device.get(uuid, { $select: 'overall_progress' }),
		]);
		if (osUpdateStatus.status === 'done') {
			console.info(
				`The device ${deviceName} has been updated to v${targetOsVersion} and will restart shortly!`,
			);
			return;
		}

		if (osUpdateStatus.error) {
			console.error(
				`Failed to complete Host OS update on device ${deviceName}!`,
			);
			exitWithExpectedError(osUpdateStatus.error);
			return;
		}

		if (osUpdateProgress !== null) {
			// Avoid resetting to 0% at end of process when device goes offline.
			progressBar.update({ percentage: osUpdateProgress });
		}

		await delay(3000);
		await poll();
	};

	await poll();
	return uuid;
}

export function inferOrSelectDevice(preferredUuid: string) {
	const balena = getBalenaSdk();
	return balena.models.device.getAll().then((devices) => {
		const onlineDevices = devices.filter((device) => device.is_online);
		if (_.isEmpty(onlineDevices)) {
			throw new ExpectedError("You don't have any devices online");
		}

		const defaultUuid = _(onlineDevices).map('uuid').includes(preferredUuid)
			? preferredUuid
			: onlineDevices[0].uuid;

		return getCliForm().ask({
			message: 'Select a device',
			type: 'list',
			default: defaultUuid,
			choices: _.map(onlineDevices, (device) => ({
				name: `${device.device_name || 'Untitled'} (${device.uuid.slice(
					0,
					7,
				)})`,
				value: device.uuid,
			})),
		});
	});
}

async function getApplicationByIdOrName(
	sdk: BalenaSdk.BalenaSDK,
	idOrName: string,
) {
	if (validation.looksLikeInteger(idOrName)) {
		try {
			return await sdk.models.application.get(Number(idOrName));
		} catch (error) {
			const { BalenaApplicationNotFound } = await import('balena-errors');
			if (!instanceOf(error, BalenaApplicationNotFound)) {
				throw error;
			}
		}
	}
	return await sdk.models.application.get(idOrName);
}

export async function getOnlineTargetUuid(
	sdk: BalenaSdk.BalenaSDK,
	applicationOrDevice: string,
) {
	// applicationOrDevice can be:
	// * an application name
	// * an application ID (integer)
	// * a device uuid
	const Logger = await import('../utils/logger');
	const logger = Logger.getLogger();
	const appTest = validation.validateApplicationName(applicationOrDevice);
	const uuidTest = validation.validateUuid(applicationOrDevice);

	if (!appTest && !uuidTest) {
		throw new ExpectedError(
			`Device or application not found: ${applicationOrDevice}`,
		);
	}

	// if we have a definite device UUID...
	if (uuidTest && !appTest) {
		logger.logDebug(
			`Fetching device by UUID ${applicationOrDevice} (${typeof applicationOrDevice})`,
		);
		return (
			await sdk.models.device.get(applicationOrDevice, {
				$select: ['uuid'],
				$filter: { is_online: true },
			})
		).uuid;
	}

	// otherwise, it may be a device OR an application...
	try {
		logger.logDebug(
			`Fetching application by ID or name ${applicationOrDevice} (${typeof applicationOrDevice})`,
		);
		const app = await getApplicationByIdOrName(sdk, applicationOrDevice);
		const devices = await sdk.models.device.getAllByApplication(app.id, {
			$filter: { is_online: true },
		});

		if (_.isEmpty(devices)) {
			throw new ExpectedError('No accessible devices are online');
		}

		return await getCliForm().ask({
			message: 'Select a device',
			type: 'list',
			default: devices[0].uuid,
			choices: _.map(devices, (device) => ({
				name: `${device.device_name || 'Untitled'} (${device.uuid.slice(
					0,
					7,
				)})`,
				value: device.uuid,
			})),
		});
	} catch (err) {
		const { BalenaApplicationNotFound } = await import('balena-errors');
		if (!instanceOf(err, BalenaApplicationNotFound)) {
			throw err;
		}
		logger.logDebug(`Application not found`);
	}

	// it wasn't an application, maybe it's a device...
	logger.logDebug(
		`Fetching device by UUID ${applicationOrDevice} (${typeof applicationOrDevice})`,
	);
	return (
		await sdk.models.device.get(applicationOrDevice, {
			$select: ['uuid'],
			$filter: { is_online: true },
		})
	).uuid;
}

export function selectFromList<T>(
	message: string,
	choices: Array<T & { name: string }>,
): Promise<T> {
	return getCliForm().ask<T>({
		message,
		type: 'list',
		choices: _.map(choices, (s) => ({
			name: s.name,
			value: s,
		})),
	});
}
