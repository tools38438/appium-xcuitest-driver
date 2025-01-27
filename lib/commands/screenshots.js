import { retryInterval } from 'asyncbox';
import _ from 'lodash';
import { getScreenshot as simctlGetScreenshot } from 'node-simctl';
import { exec } from 'teen_process';
import log from '../logger';
import { fs, tempDir, util, imageUtil } from 'appium-support';
import jimp from 'jimp';

let commands = {};

async function getScreenshotWithIdevicelib (udid, isLandscape) {
  const pathToResultPng = await tempDir.path({prefix: `screenshot-${udid}`, suffix: '.png'});
  await fs.rimraf(pathToResultPng);
  try {
    try {
      await exec('idevicescreenshot', ['-u', udid, pathToResultPng]);
    } catch (e) {
      throw new Error(`Cannot take a screenshot from the device '${udid}' using ` +
        `idevicescreenshot. Original error: ${e.message}`);
    }
    const data = await fs.readFile(pathToResultPng);
    if (!isLandscape) {
      return data.toString('base64');
    }
    const image = await jimp.read(data);
    const buffer = await image.rotate(90).getBufferAsync(jimp.MIME_PNG);
    return buffer.toString('base64');
  } finally {
    await fs.rimraf(pathToResultPng);
  }
}

async function verifyIdeviceScreenshotAvailable () {
  try {
    await fs.which('idevicescreenshot');
  } catch (err) {
    throw new Error(`No 'idevicescreenshot' program found. To use, install ` +
                    `using 'brew install --HEAD libimobiledevice'`);
  }
}

commands.getScreenshot = async function getScreenshot () {
  const getScreenshotFromIDS = async () => {
    log.debug(`Taking screenshot with 'idevicescreenshot'`);
    await verifyIdeviceScreenshotAvailable();
    const orientation = await this.proxyCommand('/orientation', 'GET');
    return await getScreenshotWithIdevicelib(this.opts.udid, orientation === 'LANDSCAPE');
  };

  const getScreenshotFromWDA = async () => {
    log.debug(`Taking screenshot with WDA`);
    const data = await this.proxyCommand('/screenshot', 'GET');
    if (!_.isString(data)) {
      throw new Error(`Unable to take screenshot. WDA returned '${JSON.stringify(data)}'`);
    }
    return data;
  };

  // ensure the user doesn't try to use 2 specialty screenshot caps
  if (this.opts.realDeviceScreenshotter && this.mjpegStream) {
    log.warn("You've specified screenshot retrieval via both MJpeg server " +
             'and a real device screenshot utility. Please use one or the ' +
             'other! Choosing MJPEG server');
  }

  // if we've specified an mjpeg server, use that
  if (this.mjpegStrem) {
    const data = await this.mjpegStream.lastChunkPNGBase64();
    if (data) {
      return data;
    }
    log.warn('Tried to get screenshot from active MJPEG stream, but there ' +
             'was no data yet. Falling back to regular screenshot methods.');
  }

  // otherwise use the real device screenshotter as specified
  const useIdeviceScreenshot = _.lowerCase(this.opts.realDeviceScreenshotter) === 'idevicescreenshot';
  if (useIdeviceScreenshot) {
    return await getScreenshotFromIDS();
  }

  try {
    return await getScreenshotFromWDA();
  } catch (err) {
    log.warn(`Error getting screenshot: ${err.message}`);
  }

  // simulator attempt
  if (this.isSimulator()) {
    log.info(`Falling back to 'simctl io screenshot' API`);
    return await simctlGetScreenshot(this.opts.udid);
  }

  // all simulator scenarios are finished
  // real device, so try idevicescreenshot if possible
  try {
    return await getScreenshotFromIDS();
  } catch (err) {
    log.warn(`Error getting screenshot through 'idevicescreenshot': ${err.message}`);
  }

  // Retry for real devices only. Fail fast on Simulator if simctl does not work as expected
  return await retryInterval(2, 1000, getScreenshotFromWDA);
};

commands.getElementScreenshot = async function getElementScreenshot (el) {
  el = util.unwrapElement(el);
  if (this.isWebContext()) {
    const atomsElement = this.useAtomsElement(el);
    return await this.executeAtom('getElementScreenshot', [atomsElement]);
  }

  const data = await this.proxyCommand(`/element/${el}/screenshot`, 'GET');
  if (!_.isString(data)) {
    log.errorAndThrow(`Unable to take a screenshot of the element ${el}. WDA returned '${JSON.stringify(data)}'`);
  }
  return data;
};

commands.getViewportScreenshot = async function getViewportScreenshot () {
  let statusBarHeight = await this.getStatusBarHeight();
  const screenshot = await this.getScreenshot();

  // if we don't have a status bar, there's nothing to crop, so we can avoid
  // extra calls and return straightaway
  if (statusBarHeight === 0) {
    return screenshot;
  }

  const scale = await this.getDevicePixelRatio();
  // status bar height comes in unscaled, so scale it
  statusBarHeight = Math.round(statusBarHeight * scale);
  const windowSize = await this.getWindowSize();
  let rect = {
    left: 0,
    top: statusBarHeight,
    width: windowSize.width * scale,
    height: ((windowSize.height * scale) - statusBarHeight)
  };
  let newScreenshot = await imageUtil.cropBase64Image(screenshot, rect);
  return newScreenshot;
};

export default commands;
