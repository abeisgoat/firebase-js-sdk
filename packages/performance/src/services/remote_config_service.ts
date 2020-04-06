/**
 * @license
 * Copyright 2019 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  CONFIG_EXPIRY_LOCAL_STORAGE_KEY,
  CONFIG_LOCAL_STORAGE_KEY,
  SDK_VERSION
} from '../constants';
import { consoleLogger } from '../utils/console_logger';
import { ERROR_FACTORY, ErrorCode } from '../utils/errors';

import { Api } from './api_service';
import { getAuthTokenPromise } from './iid_service';
import { SettingsService } from './settings_service';

const REMOTE_CONFIG_SDK_VERSION = '0.0.1';

interface SecondaryConfig {
  loggingEnabled?: boolean;
  logSource?: number;
  logEndPointUrl?: string;
  transportKey?: string;
  shouldSendToTransport?: boolean;
  tracesSamplingRate?: number;
  networkRequestsSamplingRate?: number;
}

// These values will be used if the remote config object is successfully
// retrieved, but the template does not have these fields.
const SECONDARY_CONFIGS: SecondaryConfig = {
  loggingEnabled: true,
  shouldSendToTransport: true
};

// These values will be used if the remote config object is successfully
// retrieved, but the config object state shows unspecified or no template.
const NO_TEMPLATE_CONFIGS: SecondaryConfig = {
  shouldSendToTransport: false
};

/* eslint-disable camelcase */
interface RemoteConfigTemplate {
  fpr_enabled?: string;
  fpr_log_source?: string;
  fpr_log_endpoint_url?: string;
  fpr_log_transport_key?: string;
  fpr_log_transport_web_percent?: string;
  fpr_vc_network_request_sampling_rate?: string;
  fpr_vc_trace_sampling_rate?: string;
  fpr_vc_session_sampling_rate?: string;
}
/* eslint-enable camelcase */

interface RemoteConfigResponse {
  entries?: RemoteConfigTemplate;
  state?: string;
}

const FIS_AUTH_PREFIX = 'FIREBASE_INSTALLATIONS_AUTH';

export function getConfig(iid: string): Promise<void> {
  const config = getStoredConfig();
  if (config) {
    processConfig(iid, config);
    return Promise.resolve();
  }

  return getRemoteConfig(iid)
    .then(config => processConfig(iid, config))
    .then(
      config => storeConfig(config),
      /** Do nothing for error, use defaults set in settings service. */
      () => {}
    );
}

function getStoredConfig(): RemoteConfigResponse | undefined {
  const localStorage = Api.getInstance().localStorage;
  if (!localStorage) {
    return;
  }
  const expiryString = localStorage.getItem(CONFIG_EXPIRY_LOCAL_STORAGE_KEY);
  if (!expiryString || !configValid(expiryString)) {
    return;
  }

  const configStringified = localStorage.getItem(CONFIG_LOCAL_STORAGE_KEY);
  if (!configStringified) {
    return;
  }
  try {
    const configResponse: RemoteConfigResponse = JSON.parse(configStringified);
    return configResponse;
  } catch {
    return;
  }
}

function storeConfig(config: RemoteConfigResponse | undefined): void {
  const localStorage = Api.getInstance().localStorage;
  if (!config || !localStorage) {
    return;
  }

  localStorage.setItem(CONFIG_LOCAL_STORAGE_KEY, JSON.stringify(config));
  localStorage.setItem(
    CONFIG_EXPIRY_LOCAL_STORAGE_KEY,
    String(
      Date.now() +
        SettingsService.getInstance().configTimeToLive * 60 * 60 * 1000
    )
  );
}

const COULD_NOT_GET_CONFIG_MSG =
  'Could not fetch config, will use default configs';

function getRemoteConfig(
  iid: string
): Promise<RemoteConfigResponse | undefined> {
  // Perf needs auth token only to retrieve remote config.
  return getAuthTokenPromise()
    .then(authToken => {
      const projectId = SettingsService.getInstance().getProjectId();
      const configEndPoint = `https://firebaseremoteconfig.googleapis.com/v1/projects/${projectId}/namespaces/fireperf:fetch?key=${SettingsService.getInstance().getApiKey()}`;
      const request = new Request(configEndPoint, {
        method: 'POST',
        headers: { Authorization: `${FIS_AUTH_PREFIX} ${authToken}` },
        /* eslint-disable camelcase */
        body: JSON.stringify({
          app_instance_id: iid,
          app_instance_id_token: authToken,
          app_id: SettingsService.getInstance().getAppId(),
          app_version: SDK_VERSION,
          sdk_version: REMOTE_CONFIG_SDK_VERSION
        })
        /* eslint-enable camelcase */
      });
      return fetch(request).then(response => {
        if (response.ok) {
          return response.json() as RemoteConfigResponse;
        }
        // In case response is not ok. This will be caught by catch.
        throw ERROR_FACTORY.create(ErrorCode.RC_NOT_OK);
      });
    })
    .catch(() => {
      consoleLogger.info(COULD_NOT_GET_CONFIG_MSG);
      return undefined;
    });
}

/**
 * Processes config coming either from calling RC or from local storage.
 * This method only runs if call is successful or config in storage
 * is valid.
 */
function processConfig(
  iid: string,
  config: RemoteConfigResponse | undefined
): RemoteConfigResponse | undefined {
  if (!config) {
    return config;
  }
  const settingsServiceInstance = SettingsService.getInstance();
  const entries = config.entries || {};
  const state = config.state;
  if (entries.fpr_enabled !== undefined) {
    // TODO: Change the assignment of loggingEnabled once the received type is
    // known.
    settingsServiceInstance.loggingEnabled =
      String(entries.fpr_enabled) === 'true';
  } else if (SECONDARY_CONFIGS.loggingEnabled !== undefined) {
    // Config retrieved successfully, but there is no fpr_enabled in template.
    // Use secondary configs value.
    settingsServiceInstance.loggingEnabled = SECONDARY_CONFIGS.loggingEnabled;
  }
  if (entries.fpr_log_source) {
    settingsServiceInstance.logSource = Number(entries.fpr_log_source);
  } else if (SECONDARY_CONFIGS.logSource) {
    settingsServiceInstance.logSource = SECONDARY_CONFIGS.logSource;
  }

  if (entries.fpr_log_endpoint_url) {
    settingsServiceInstance.logEndPointUrl = entries.fpr_log_endpoint_url;
  } else if (SECONDARY_CONFIGS.logEndPointUrl) {
    settingsServiceInstance.logEndPointUrl = SECONDARY_CONFIGS.logEndPointUrl;
  }

  // Key from Remote Config has to be non-empty string, otherwsie use local value.
  if (entries.fpr_log_transport_key) {
    settingsServiceInstance.transportKey = entries.fpr_log_transport_key;
  } else if (SECONDARY_CONFIGS.transportKey) {
    settingsServiceInstance.transportKey = SECONDARY_CONFIGS.transportKey;
  }

  // If config object state indicates that no template has been set, that means it is new user of
  // Performance Monitoring and should use the old log endpoint, because it is guaranteed to work.
  if (
    state === undefined ||
    state === 'INSTANCE_STATE_UNSPECIFIED' ||
    state === 'NO_TEMPLATE'
  ) {
    if (NO_TEMPLATE_CONFIGS.shouldSendToTransport !== undefined) {
      settingsServiceInstance.shouldSendToTransport =
        NO_TEMPLATE_CONFIGS.shouldSendToTransport;
    }
  } else if (entries.fpr_log_transport_web_percent !== undefined) {
    // If config object state doesn't indicate no template, it can only be UPDATE for now.
    // - Performance Monitoring doesn't set etag in request, therefore state cannot be NO_CHANGE.
    // - Sampling rate flags and master flag are required, therefore state cannot be EMPTY_CONFIG.
    // If config object state is UPDATE and rollout flag is present, determine endpoint by iid.
    settingsServiceInstance.shouldSendToTransport = isDestTransport(
      iid,
      Number(entries.fpr_log_transport_web_percent)
    );
  } else if (SECONDARY_CONFIGS.shouldSendToTransport !== undefined) {
    // If config object state is UPDATE and rollout flag is not present, that means rollout is
    // complete and rollout flag is deprecated, therefore dispatch events to new transport endpoint.
    settingsServiceInstance.shouldSendToTransport =
      SECONDARY_CONFIGS.shouldSendToTransport;
  }

  if (entries.fpr_vc_network_request_sampling_rate !== undefined) {
    settingsServiceInstance.networkRequestsSamplingRate = Number(
      entries.fpr_vc_network_request_sampling_rate
    );
  } else if (SECONDARY_CONFIGS.networkRequestsSamplingRate !== undefined) {
    settingsServiceInstance.networkRequestsSamplingRate =
      SECONDARY_CONFIGS.networkRequestsSamplingRate;
  }
  if (entries.fpr_vc_trace_sampling_rate !== undefined) {
    settingsServiceInstance.tracesSamplingRate = Number(
      entries.fpr_vc_trace_sampling_rate
    );
  } else if (SECONDARY_CONFIGS.tracesSamplingRate !== undefined) {
    settingsServiceInstance.tracesSamplingRate =
      SECONDARY_CONFIGS.tracesSamplingRate;
  }
  // Set the per session trace and network logging flags.
  settingsServiceInstance.logTraceAfterSampling = shouldLogAfterSampling(
    settingsServiceInstance.tracesSamplingRate
  );
  settingsServiceInstance.logNetworkAfterSampling = shouldLogAfterSampling(
    settingsServiceInstance.networkRequestsSamplingRate
  );
  return config;
}

function configValid(expiry: string): boolean {
  return Number(expiry) > Date.now();
}

function shouldLogAfterSampling(samplingRate: number): boolean {
  return Math.random() <= samplingRate;
}

/**
 * True if event should be sent to transport endpoint rather than log endpoint.
 * rolloutPercent is in range [0.0, 100.0].
 * @param {string} iid Installation ID which identifies a web app installed on client.
 * @param {number} rolloutPercent the possibility of this app sending events to transport endpoint.
 * @return {boolean} true if this installation should send events to transport endpoint.
 */
export function isDestTransport(iid: string, rolloutPercent: number): boolean {
  if (iid.length === 0) {
    return false;
  }
  return getHashPercent(iid) < rolloutPercent;
}
/**
 * Generate integer value range in [0, 99].
 * @param {string} seed Same seed will generate consistent hash value using this algorithm.
 * @return {number} Hash value in range [0, 99], generated from seed and hash algorithm.
 */
function getHashPercent(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 3) + hash - seed.charCodeAt(i);
  }
  hash = Math.abs(hash % 100);
  return hash;
}
