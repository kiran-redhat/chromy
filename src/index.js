const fs = require('fs')
const nodeUrl = require('url')

const CDP = require('chrome-remote-interface')
const uuidV4 = require('uuid/v4')
const devices = require('./devices')
const {createFullscreenEmulationManager} = require('./emulation')
const Jimp = require('jimp')

const Document = require('./document')

const {
  TimeoutError,
  GotoTimeoutError,
} = require('./error')
const {
  createChromeLauncher,
  completeUrl,
} = require('./util')

let instances = []
let instanceId = 1

function makeSendToChromy (uuid) {
  return `
  function () {
    console.info('${uuid}:' + JSON.stringify(arguments))
  }
  `
}

function defaultTargetFunction (targets) {
  return targets.filter(t => t.type === 'page').shift()
}

class Chromy extends Document {
  constructor (options = {}) {
    super(null, null, null)
    let chromePath = null
    if (options.chromePath) {
      chromePath = options.chromePath
    } else if (process.env.CHROME_PATH) {
      chromePath = process.env.CHROME_PATH
    }
    const defaults = {
      host: 'localhost',
      port: 9222,
      launchBrowser: true,
      userDataDir: null,
      chromeFlags: [],
      chromePath: chromePath,
      enableExtensions: false,
      activateOnStartUp: true,
      waitTimeout: 30000,
      gotoTimeout: 30000,
      loadTimeout: 30000,
      evaluateTimeout: 30000,
      waitFunctionPollingInterval: 100,
      typeInterval: 20,
      target: defaultTargetFunction,
    }
    this.options = Object.assign({}, defaults, options)
    this.cdpOptions = {
      host: this.options.host,
      port: this.options.port,
      target: this.options.target,
    }
    this.client = null
    this.launcher = null
    this.messagePrefix = null
    this.emulateMode = false
    this.currentEmulateDeviceName = null
    this.currentDeviceScaleFactor = null
    this.userAgentBeforeEmulate = null
    this.instanceId = instanceId++
  }

  static addCustomDevice (cusDevices = []) {
    if (!Array.isArray(cusDevices)) {
      cusDevices = [cusDevices]
    }
    cusDevices.forEach(item => {
      devices[item.name] = item
    })
  }

  async start (startingUrl = null) {
    if (startingUrl === null) {
      startingUrl = 'about:blank'
    }
    if (this.client !== null) {
      return
    }

    if (this.options.launchBrowser) {
      if (this.launcher === null) {
        this.launcher = await createChromeLauncher(completeUrl(startingUrl), this.options)
        this._sigintHandler = async () => {
          await this.close()
          process.exit(130)
        }
        process.on('SIGINT', this._sigintHandler)
      }

      if (!this.launcher.pid) {
        throw new Error('Failed to launch a browser.')
      }
      instances.push(this)
    }

    await new Promise((resolve, reject) => {
      CDP(this.cdpOptions, async (client) => {
        try {
          this.client = client
          const {DOM, Network, Page, Runtime, Console} = client
          await Promise.all([DOM.enable(), Network.enable(), Page.enable(), Runtime.enable(), Console.enable()])

          await this._cacheChromeVersion()
          if (this._chromeVersion < 61) {
            console.warn('Chromy requires Chrome ver.61 or later. Please install latest version Chrome.')
          }

          // activate first tab
          if (this.options.activateOnStartUp) {
            let targetId = await this._getTargetIdFromOption()
            await this.client.Target.activateTarget({targetId: targetId})
          }

          if ('userAgent' in this.options) {
            await this.userAgent(this.options.userAgent)
          }
          if ('headers' in this.options) {
            await this.headers(this.options.headers)
          }
          this._activateOnDocumentUpdatedListener()
          resolve(this)
        } catch (e) {
          reject(e)
        }
      }).on('error', (err) => {
        reject(err)
      })
    }).catch(e => {
      throw e
    })
  }

  async _getTargetIdFromOption () {
    if (typeof this.options.target === 'function') {
      const result = await this.client.Target.getTargets()
      const page = this.options.target(result.targetInfos)
      return page.targetId
    } else if (typeof this.options.target === 'object') {
      return this.options.target.targetId
    } else if (typeof this.options.target === 'string') {
      return this.options.target
    } else {
      throw new Error('type of `target` option is invalid.')
    }
  }

  async close () {
    if (this.client === null) {
      return false
    }
    await this.client.close()
    this.client = null
    if (this.launcher !== null) {
      await this.launcher.kill()
      process.removeListener('SIGINT', this._sigintHandler)
      this.launcher = null
    }
    instances = instances.filter(i => i.instanceId !== this.instanceId)
    return true
  }

  static async cleanup () {
    const copy = [].concat(instances)
    const promises = copy.map(i => i.close())
    await Promise.all(promises)
  }

  async getPageTargets () {
    const result = await this.client.Target.getTargets()
    return result.targetInfos.filter(t => t.type === 'page')
  }

  async userAgent (ua) {
    await this._checkStart()
    return await this.client.Network.setUserAgentOverride({'userAgent': ua})
  }

  /**
   * Example:
   * chromy.headers({'X-Requested-By': 'foo'})
   */
  async headers (headers) {
    await this._checkStart()
    return await this.client.Network.setExtraHTTPHeaders({'headers': headers})
  }

  async ignoreCertificateErrors () {
    await this._checkStart()
    await this.client.Security.enable()
    await this.client.Security.setOverrideCertificateErrors({override: true})
    await this.client.Security.certificateError(({eventId}) => {
      this.client.Security.handleCertificateError({
        eventId,
        action: 'continue',
      })
    })
  }

  async console (callback) {
    await this._checkStart()
    this.client.Console.messageAdded((payload) => {
      try {
        const msg = payload.message.text
        const pre = this.messagePrefix
        if (typeof msg !== 'undefined') {
          if (pre === null || msg.substring(0, pre.length + 1) !== pre + ':') {
            callback.apply(this, [msg, payload.message])
          }
        }
      } catch (e) {
        console.warn(e)
      }
    })
  }

  async receiveMessage (callback) {
    await this._checkStart()
    const uuid = uuidV4()
    this.messagePrefix = uuid
    const f = makeSendToChromy(this.messagePrefix)
    this.defineFunction({sendToChromy: f})
    this.client.Console.messageAdded((payload) => {
      try {
        const msg = payload.message.text
        if (msg && msg.substring(0, uuid.length + 1) === uuid + ':') {
          const data = JSON.parse(msg.substring(uuid.length + 1))
          callback.apply(this, [data])
        }
      } catch (e) {
        console.warn(e)
      }
    })
  }

  async goto (url, options) {
    // correct url form.
    url = nodeUrl.format(nodeUrl.parse(url))
    const defaultOptions = {
      waitLoadEvent: true,
    }
    options = Object.assign({}, defaultOptions, options)
    await this._checkStart(url)
    let response = null
    // truck redirects.
    let requestListener = (payload) => {
      if (payload.redirectResponse && payload.redirectResponse.url === url) {
        url = payload.redirectResponse.headers.location
      }
    }
    const requestEventName = 'Network.requestWillBeSent'
    await this.on(requestEventName, requestListener)
    let listener = (payload) => {
      if (payload.response.url === url) {
        response = payload.response
      }
    }
    const eventName = 'Network.responseReceived'
    await this.on(eventName, listener)
    try {
      await this._waitFinish(this.options.gotoTimeout, async () => {
        await this.client.Page.navigate({url: completeUrl(url)})
        if (options.waitLoadEvent) {
          await this.client.Page.loadEventFired()
        }
      })
    } catch (e) {
      if (e instanceof TimeoutError) {
        throw new GotoTimeoutError('goto() timeout')
      } else {
        throw e
      }
    } finally {
      await this.removeListener(eventName, listener)
      await this.removeListener(requestEventName, requestListener)
    }
    return response
  }

  async waitLoadEvent () {
    await this._waitFinish(this.options.loadTimeout, async () => {
      await this.client.Page.loadEventFired()
    })
  }

  async forward () {
    const f = 'window.history.forward()'
    const promise = this.waitLoadEvent()
    await this.client.Runtime.evaluate({expression: f})
    await promise
  }

  async back () {
    const f = 'window.history.back()'
    const promise = this.waitLoadEvent()
    await this.client.Runtime.evaluate({expression: f})
    await promise
  }

  async reload (ignoreCache, scriptToEvaluateOnLoad) {
    await this.client.Page.reload({ignoreCache, scriptToEvaluateOnLoad})
  }

  /**
   * define function
   *
   * @param func {(function|string|Array.<function>|Array.<string>)}
   * @returns {Promise.<void>}
   */
  async defineFunction (def) {
    let funcs = []
    if (Array.isArray(def)) {
      funcs = def
    } else if ((typeof def) === 'object') {
      funcs = this._moduleToFunctionSources(def)
    } else {
      funcs.push(def)
    }
    for (let i = 0; i < funcs.length; i++) {
      let f = funcs[i]
      if ((typeof f) === 'function') {
        f = f.toString()
      }
      await this.client.Runtime.evaluate({expression: f})
    }
  }

  _moduleToFunctionSources (module) {
    const result = []
    for (let funcName in module) {
      let func = module[funcName]
      let src = `function ${funcName} () { return (${func.toString()})(...arguments) }`.trim()
      result.push(src)
    }
    return result
  }

  async mouseMoved (x, y, options = {}) {
    const opts = Object.assign({type: 'mouseMoved', x: x, y: y}, options)
    await this.client.Input.dispatchMouseEvent(opts)
  }

  async mousePressed (x, y, options = {}) {
    const opts = Object.assign({type: 'mousePressed', x: x, y: y, button: 'left'}, options)
    await this.client.Input.dispatchMouseEvent(opts)
  }

  async mouseReleased (x, y, options = {}) {
    const opts = Object.assign({type: 'mouseReleased', x: x, y: y, button: 'left'}, options)
    await this.client.Input.dispatchMouseEvent(opts)
  }

  async tap (x, y, options = {}) {
    const time = Date.now() / 1000
    const opts = Object.assign({x: x, y: y, timestamp: time, button: 'left'}, options)
    await this.client.Input.synthesizeTapGesture(opts)
  }

  async doubleTap (x, y, options = {}) {
    const time = Date.now() / 1000
    const opts = Object.assign({x: x, y: y, timestamp: time, button: 'left', tapCount: 2}, options)
    await this.client.Input.synthesizeTapGesture(opts)
  }

  async setFile (selector, files) {
    let paramFiles = files
    if ((typeof files) === 'string') {
      paramFiles = [files]
    }
    if (paramFiles.length === 0) {
      return
    }
    const {root} = await this.client.DOM.getDocument()
    const {nodeId: fileNodeId} = await this.client.DOM.querySelector({
      nodeId: root.nodeId,
      selector: selector,
    })
    if (!fileNodeId) {
      return
    }
    await this.client.DOM.setFileInputFiles({
      nodeId: fileNodeId,
      files: paramFiles,
    })
  }

  async screenshot (format = 'png', quality = undefined, fromSurface = true) {
    let opts = {
      format: 'png',
      fromSurface: true,
      useDeviceResolution: false,
    }
    if ((typeof format) === 'string') {
      // deprecated arguments style
      const params = {
        format: format,
        quality: quality,
        fromSurface: fromSurface,
      }
      opts = Object.assign({}, opts, params)
    } else if ((typeof format) === 'object') {
      opts = Object.assign({}, opts, format)
    }
    if (['png', 'jpeg'].indexOf(opts.format) === -1) {
      throw new Error('format is invalid.')
    }
    const captureParams = Object.assign({}, opts)
    delete captureParams.useDeviceResolution
    let captureResult = await this.client.Page.captureScreenshot(captureParams)
    let image = Buffer.from(captureResult.data, 'base64')
    if (!opts.useDeviceResolution) {
      const screen = await this._getScreenInfo()
      if (screen.devicePixelRatio !== 1) {
        let promise = new Promise((resolve, reject) => {
          Jimp.read(image, (err, img) => {
            if (err) {
              return reject(err)
            }
            let fmt = opts.format === 'png' ? Jimp.MIME_PNG : Jimp.MIME_JPEG
            let quality = 100
            if (opts.quality) {
              quality = opts.quality
            }
            img.scale(1.0 / screen.devicePixelRatio, Jimp.RESIZE_BEZIER)
              .quality(quality)
              .getBuffer(fmt, (err, buffer) => {
                if (err) {
                  reject(err)
                } else {
                  resolve(buffer)
                }
              })
          })
        })
        image = await promise
      }
    }
    return image
  }

  /*
   * Limitation:
   * maximum height is 16384px because of chrome's bug from Skia library.
   * https://groups.google.com/a/chromium.org/d/msg/headless-dev/DqaAEXyzvR0/kUTEqNYiDQAJ
   * https://stackoverflow.com/questions/44599858/max-height-of-16-384px-for-headless-chrome-screenshots
   */
  async screenshotDocument (model = 'scroll', format = 'png', quality = undefined, fromSurface = true) {
    let opts = {
      model: 'scroll',
      format: 'png',
      fromSurface: true,
      useDeviceResolution: false,
    }
    if ((typeof model) === 'string') {
      const params = {
        model: model,
        format: format,
        quality: quality,
        fromSurface: fromSurface,
      }
      opts = Object.assign({}, opts, params)
    } else if ((typeof model) === 'object') {
      opts = Object.assign({}, opts, model)
    }
    const emulation = await createFullscreenEmulationManager(this, opts.model, false, opts.useDeviceResolution)

    let result = null
    try {
      await emulation.emulate()
      // device resolution is already emulated by emulation manager, so useDeviceResotion must be set true
      const screenshotParams = Object.assign({}, opts, {useDeviceResolution: true})
      delete screenshotParams.model
      result = await this.screenshot(screenshotParams)
    } finally {
      await emulation.reset()
      // restore emulation mode
      await this._restoreEmulationSetting()
    }
    return result
  }

  async screenshotSelector (selector, format = 'png', quality = undefined, fromSurface = true) {
    let opts = {
      format: 'png',
      fromSurface: true,
      useDeviceResolution: false,
    }
    if ((typeof format) === 'string') {
      const params = {
        format: format,
        quality: quality,
        fromSurface: fromSurface,
      }
      opts = Object.assign({}, opts, params)
    } else if ((typeof format) === 'object') {
      opts = Object.assign({}, opts, format)
    }
    return this._screenshotSelector(selector, opts)
  }

  async _screenshotSelector (selector, opts) {
    const emulation = await createFullscreenEmulationManager(this, 'scroll', true, opts.useDeviceResolution)
    let buffer = null
    try {
      await emulation.emulate()
      await this.scrollTo(0, 0)
      let rect = await this.getBoundingClientRect(selector)
      if (!rect || rect.width === 0 || rect.height === 0) {
        return null
      }
      let clip = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        scale: 1,
      }
      let screenshotOpts = Object.assign({}, opts, {clip})
      const {data} = await this.client.Page.captureScreenshot(screenshotOpts)
      buffer = Buffer.from(data, 'base64')
    } finally {
      emulation.reset()
    }
    return buffer
  }

  async screenshotMultipleSelectors (selectors, callback, options = {}) {
    return this._screenshotMultipleSelectors(selectors, callback, options)
  }

  async _screenshotMultipleSelectors (selectors, callback, options = {}) {
    const defaults = {
      model: 'scroll',
      format: 'png',
      quality: undefined,
      fromSurface: true,
      useDeviceResolution: false,
      useQuerySelectorAll: false,
    }
    const opts = Object.assign({}, defaults, options)
    const emulation = await createFullscreenEmulationManager(this, 'scroll', true, opts.useDeviceResolution)
    await emulation.emulate()
    try {
      for (let selIdx = 0; selIdx < selectors.length; selIdx++) {
        let selector = selectors[selIdx]
        try {
          let rects = null
          if (opts.useQuerySelectorAll) {
            rects = await this.rectAll(selector)
            // remove elements that has 'display: none'
            rects = rects.filter(rect => rect.width !== 0 && rect.height !== 0)
          } else {
            const r = await this.getBoundingClientRect(selector)
            if (r && r.width !== 0 && r.height !== 0) {
              rects = [r]
            }
          }
          if (rects.length === 0) {
            const err = {reason: 'notfound', message: `selector is not found. selector=${selector}`}
            await callback.apply(this, [err, null, selIdx, selectors])
            continue
          }

          for (let rectIdx = 0; rectIdx < rects.length; rectIdx++) {
            const rect = rects[rectIdx]
            let clip = {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
              scale: 1,
            }
            let screenshotOpts = Object.assign({
              format: opts.format,
              quality: opts.quality,
              fromSurface: opts.fromSurface,
              clip,
            })
            const {data} = await this.client.Page.captureScreenshot(screenshotOpts)
            let buffer = Buffer.from(data, 'base64')
            await callback.apply(this, [null, buffer, selIdx, selectors, rectIdx])
          }
        } catch (e) {
          await callback.apply(this, [e, null, selIdx, selectors])
        }
      }
    } finally {
      await emulation.reset()
      await this._restoreEmulationSetting()
    }
  }

  async pdf (options = {}) {
    const {data} = await this.client.Page.printToPDF(options)
    return Buffer.from(data, 'base64')
  }

  async startScreencast (callback, options = {}) {
    await this.client.Page.screencastFrame(async (payload) => {
      await callback.apply(this, [payload])
      await this.client.Page.screencastFrameAck({sessionId: payload.sessionId})
    })
    await this.client.Page.startScreencast(options)
  }

  async stopScreencast () {
    await this.client.Page.stopScreencast()
  }

  // deprecated since 0.3.4
  async requestWillBeSent (callback) {
    await this._checkStart()
    await this.client.Network.requestWillBeSent(callback)
  }

  async send (event, parameter) {
    await this._checkStart()
    return this.client.send(event, parameter)
  }

  async on (event, callback) {
    await this._checkStart()
    this.client.on(event, callback)
  }

  async once (event, callback) {
    await this._checkStart()
    this.client.once(event, callback)
  }

  async removeListener (event, callback) {
    await this._checkStart()
    this.client.removeListener(event, callback)
  }

  async removeAllListeners (event) {
    await this._checkStart()
    this.client.removeAllListeners(event)
  }

  async inject (type, fileOrBuffer) {
    const data = fileOrBuffer instanceof Buffer ? fileOrBuffer.toString('utf8') : await new Promise((resolve, reject) => {
      fs.readFile(fileOrBuffer, {encoding: 'utf-8'}, (err, data) => {
        if (err) reject(err)
        resolve(data)
      })
    }).catch(e => {
      throw e
    })
    if (type === 'js') {
      let script = data.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/(\r|\n)/g, '\\n')
      let expr = `
      {
         let script = document.createElement('script')
         script.type = 'text/javascript'
         script.innerHTML = '${script}'
         document.body.appendChild(script)
      }
      `
      return this.evaluate(expr)
    } else if (type === 'css') {
      let style = data.replace(/`/g, '\\`').replace(/\\/g, '\\\\') // .replace(/(\r|\n)/g, ' ')
      let expr = `
      {
         let style = document.createElement('style')
         style.type = 'text/css'
         style.innerText = \`
        ${style}
        \`
         document.head.appendChild(style)
      }
      `
      return this.evaluate(expr)
    } else {
      throw new Error('found invalid type.')
    }
  }

  async setDeviceScaleFactor (deviceScaleFactor) {
    const screen = await this._getScreenInfo()
    if (screen.devicePixelRatio === deviceScaleFactor) {
      return
    }
    this.currentDeviceScaleFactor = deviceScaleFactor
    return this.client.Emulation.setDeviceMetricsOverride({
      width: 0, height: 0, deviceScaleFactor: deviceScaleFactor, mobile: false,
    })
  }

  async emulate (deviceName) {
    await this._checkStart()

    if (!this.emulateMode) {
      this.userAgentBeforeEmulate = await this.evaluate('return navigator.userAgent')
    }
    const device = devices[deviceName]
    await this.client.Emulation.setDeviceMetricsOverride({
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.deviceScaleFactor,
      mobile: device.mobile,
      fitWindow: false,
      scale: device.pageScaleFactor,
    })
    const platform = device.mobile ? 'mobile' : 'desktop'
    await this.client.Emulation.setTouchEmulationEnabled({enabled: true, configuration: platform})
    await this.userAgent(device.userAgent)
    this.currentEmulateDeviceName = deviceName
    this.emulateMode = true
  }

  async clearEmulate () {
    await this.client.Emulation.clearDeviceMetricsOverride()
    await this.client.Emulation.setTouchEmulationEnabled({enabled: false})
    if (this.userAgentBeforeEmulate) {
      await this.userAgent(this.userAgentBeforeEmulate)
    }
    this.emulateMode = false
    this.currentEmulateDeviceName = null
  }

  async _restoreEmulationSetting () {
    // restore emulation mode
    if (this.currentEmulateDeviceName !== null) {
      await this.emulate(this.currentEmulateDeviceName)
    }
    if (this.currentDeviceScaleFactor) {
      await this.setDeviceScaleFactor(this.currentDeviceScaleFactor)
    }
  }

  async blockUrls (urls) {
    await this._checkStart()
    await this.client.Network.setBlockedURLs({urls: urls})
  }

  async clearBrowserCache () {
    await this._checkStart()
    await this.client.Network.clearBrowserCache()
  }

  async setCookie (params) {
    await this._checkStart()
    let paramArray = null
    if (Array.isArray(params)) {
      paramArray = params
    } else {
      paramArray = [params]
    }
    const currentUrl = await this.evaluate(_ => { return location.href })
    paramArray = paramArray.map(obj => {
      if (obj.url) {
        return obj
      } else {
        obj.url = currentUrl
        return obj
      }
    })
    for (let i in paramArray) {
      const item = paramArray[i]
      await this.client.Network.setCookie(item)
    }
  }

  async deleteCookie (name, url = null) {
    await this._checkStart()
    let nameArray = null
    if (Array.isArray(name)) {
      nameArray = name
    } else {
      nameArray = [name]
    }
    let paramUrl = url
    if (!url) {
      paramUrl = await this.evaluate(_ => { return location.href })
    }
    for (let i in nameArray) {
      const n = nameArray[i]
      await this.client.Network.deleteCookie({cookieName: n, url: paramUrl})
    }
  }

  async clearAllCookies () {
    await this._checkStart()
    await this.client.Network.clearBrowserCookies()
  }

  async getDOMCounters () {
    return await this.client.Memory.getDOMCounters()
  }

  async clearDataForOrigin (origin = null, type = 'all') {
    if (origin === null) {
      origin = await this.evaluate(_ => { return location.origin })
    }
    return await this.client.Storage.clearDataForOrigin({origin: origin, storageTypes: type})
  }

  async _checkStart (startingUrl = null) {
    if (this.client === null) {
      await this.start(startingUrl)
    }
  }

  async _cacheChromeVersion () {
    this._chromeVersion = await this._getChromeVersion()
  }

  async _getChromeVersion () {
    let userAgent = null
    try {
      const result = await this.client.send('Browser.getVersion')
      userAgent = result.product
    } catch (_) {
      // ignore
    }
    if (userAgent === null) {
      userAgent = await this.evaluate(_ => {
        return navigator.userAgent
      })
    }
    let v = userAgent.match(/Chrom(e|ium)\/([0-9]+)\./)
    return v ? parseInt(v[2], 10) : false
  }
}

module.exports = Chromy

