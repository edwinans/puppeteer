/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {Readable} from 'stream';

import {Protocol} from 'devtools-protocol';

import type {Browser} from '../api/Browser.js';
import type {BrowserContext} from '../api/BrowserContext.js';
import {CDPSessionEvent, type CDPSession} from '../api/CDPSession.js';
import {type ElementHandle} from '../api/ElementHandle.js';
import {type WaitForOptions, type Frame} from '../api/Frame.js';
import {type HTTPRequest} from '../api/HTTPRequest.js';
import {type HTTPResponse} from '../api/HTTPResponse.js';
import {type JSHandle} from '../api/JSHandle.js';
import {
  Page,
  PageEvent,
  type GeolocationOptions,
  type MediaFeature,
  type Metrics,
  type NewDocumentScriptEvaluation,
  type ScreenshotClip,
  type ScreenshotOptions,
  type WaitTimeoutOptions,
} from '../api/Page.js';
import {
  ConsoleMessage,
  type ConsoleMessageType,
} from '../common/ConsoleMessage.js';
import {TargetCloseError} from '../common/Errors.js';
import {FileChooser} from '../common/FileChooser.js';
import {type PDFOptions} from '../common/PDFOptions.js';
import {type TaskQueue} from '../common/TaskQueue.js';
import {TimeoutSettings} from '../common/TimeoutSettings.js';
import {type BindingPayload, type HandleFor} from '../common/types.js';
import {
  createClientError,
  debugError,
  evaluationString,
  getReadableAsBuffer,
  getReadableFromProtocolStream,
  isString,
  pageBindingInitString,
  validateDialogType,
  valueFromRemoteObject,
  waitForEvent,
  waitWithTimeout,
} from '../common/util.js';
import {type Viewport} from '../common/Viewport.js';
import {assert} from '../util/assert.js';
import {Deferred} from '../util/Deferred.js';
import {isErrorLike} from '../util/ErrorLike.js';

import {Accessibility} from './Accessibility.js';
import {Binding} from './Binding.js';
import {CdpCDPSession} from './CDPSession.js';
import {isTargetClosedError} from './Connection.js';
import {Coverage} from './Coverage.js';
import {type DeviceRequestPrompt} from './DeviceRequestPrompt.js';
import {CdpDialog} from './Dialog.js';
import {EmulationManager} from './EmulationManager.js';
import {createCdpHandle, releaseObject} from './ExecutionContext.js';
import {type CdpFrame} from './Frame.js';
import {FrameManager, FrameManagerEvent} from './FrameManager.js';
import {CdpKeyboard, CdpMouse, CdpTouchscreen} from './Input.js';
import {MAIN_WORLD} from './IsolatedWorlds.js';
import {
  NetworkManagerEvent,
  type Credentials,
  type NetworkConditions,
} from './NetworkManager.js';
import {type CdpTarget} from './Target.js';
import {TargetManagerEvent} from './TargetManager.js';
import {Tracing} from './Tracing.js';
import {WebWorker} from './WebWorker.js';

/**
 * @internal
 */
export class CdpPage extends Page {
  static async _create(
    client: CDPSession,
    target: CdpTarget,
    ignoreHTTPSErrors: boolean,
    defaultViewport: Viewport | null,
    screenshotTaskQueue: TaskQueue
  ): Promise<CdpPage> {
    const page = new CdpPage(
      client,
      target,
      ignoreHTTPSErrors,
      screenshotTaskQueue
    );
    await page.#initialize();
    if (defaultViewport) {
      try {
        await page.setViewport(defaultViewport);
      } catch (err) {
        if (isErrorLike(err) && isTargetClosedError(err)) {
          debugError(err);
        } else {
          throw err;
        }
      }
    }
    return page;
  }

  #closed = false;
  #client: CDPSession;
  #tabSession: CDPSession | undefined;
  #target: CdpTarget;
  #keyboard: CdpKeyboard;
  #mouse: CdpMouse;
  #timeoutSettings = new TimeoutSettings();
  #touchscreen: CdpTouchscreen;
  #accessibility: Accessibility;
  #frameManager: FrameManager;
  #emulationManager: EmulationManager;
  #tracing: Tracing;
  #bindings = new Map<string, Binding>();
  #exposedFunctions = new Map<string, string>();
  #coverage: Coverage;
  #viewport: Viewport | null;
  #screenshotTaskQueue: TaskQueue;
  #workers = new Map<string, WebWorker>();
  #fileChooserDeferreds = new Set<Deferred<FileChooser>>();
  #sessionCloseDeferred = Deferred.create<TargetCloseError>();
  #serviceWorkerBypassed = false;
  #userDragInterceptionEnabled = false;

  #frameManagerHandlers = Object.freeze([
    [
      FrameManagerEvent.FrameAttached,
      (frame: CdpFrame) => {
        this.emit(PageEvent.FrameAttached, frame);
      },
    ],
    [
      FrameManagerEvent.FrameDetached,
      (frame: CdpFrame) => {
        this.emit(PageEvent.FrameDetached, frame);
      },
    ],
    [
      FrameManagerEvent.FrameNavigated,
      (frame: CdpFrame) => {
        this.emit(PageEvent.FrameNavigated, frame);
      },
    ],
  ] as const);

  #networkManagerHandlers = Object.freeze([
    [
      NetworkManagerEvent.Request,
      (request: HTTPRequest) => {
        this.emit(PageEvent.Request, request);
      },
    ],
    [
      NetworkManagerEvent.RequestServedFromCache,
      (request: HTTPRequest) => {
        this.emit(PageEvent.RequestServedFromCache, request);
      },
    ],
    [
      NetworkManagerEvent.Response,
      (response: HTTPResponse) => {
        this.emit(PageEvent.Response, response);
      },
    ],
    [
      NetworkManagerEvent.RequestFailed,
      (request: HTTPRequest) => {
        this.emit(PageEvent.RequestFailed, request);
      },
    ],
    [
      NetworkManagerEvent.RequestFinished,
      (request: HTTPRequest) => {
        this.emit(PageEvent.RequestFinished, request);
      },
    ],
  ] as const);

  #sessionHandlers = Object.freeze([
    [
      CDPSessionEvent.Disconnected,
      () => {
        this.#sessionCloseDeferred.resolve(
          new TargetCloseError('Target closed')
        );
      },
    ],
    [
      'Page.domContentEventFired',
      () => {
        return this.emit(PageEvent.DOMContentLoaded, undefined);
      },
    ],
    [
      'Page.loadEventFired',
      () => {
        return this.emit(PageEvent.Load, undefined);
      },
    ],
    ['Runtime.consoleAPICalled', this.#onConsoleAPI.bind(this)],
    ['Runtime.bindingCalled', this.#onBindingCalled.bind(this)],
    ['Page.javascriptDialogOpening', this.#onDialog.bind(this)],
    ['Runtime.exceptionThrown', this.#handleException.bind(this)],
    ['Inspector.targetCrashed', this.#onTargetCrashed.bind(this)],
    ['Performance.metrics', this.#emitMetrics.bind(this)],
    ['Log.entryAdded', this.#onLogEntryAdded.bind(this)],
    ['Page.fileChooserOpened', this.#onFileChooser.bind(this)],
  ] as const);

  constructor(
    client: CDPSession,
    target: CdpTarget,
    ignoreHTTPSErrors: boolean,
    screenshotTaskQueue: TaskQueue
  ) {
    super();
    this.#client = client;
    this.#tabSession = client.parentSession();
    this.#target = target;
    this.#keyboard = new CdpKeyboard(client);
    this.#mouse = new CdpMouse(client, this.#keyboard);
    this.#touchscreen = new CdpTouchscreen(client, this.#keyboard);
    this.#accessibility = new Accessibility(client);
    this.#frameManager = new FrameManager(
      client,
      this,
      ignoreHTTPSErrors,
      this.#timeoutSettings
    );
    this.#emulationManager = new EmulationManager(client);
    this.#tracing = new Tracing(client);
    this.#coverage = new Coverage(client);
    this.#screenshotTaskQueue = screenshotTaskQueue;
    this.#viewport = null;

    this.#setupEventListeners();

    this.#tabSession?.on(CDPSessionEvent.Swapped, async newSession => {
      this.#client = newSession;
      assert(
        this.#client instanceof CdpCDPSession,
        'CDPSession is not instance of CDPSessionImpl'
      );
      this.#target = this.#client._target();
      assert(this.#target, 'Missing target on swap');
      this.#keyboard.updateClient(newSession);
      this.#mouse.updateClient(newSession);
      this.#touchscreen.updateClient(newSession);
      this.#accessibility.updateClient(newSession);
      this.#emulationManager.updateClient(newSession);
      this.#tracing.updateClient(newSession);
      this.#coverage.updateClient(newSession);
      await this.#frameManager.swapFrameTree(newSession);
      this.#setupEventListeners();
    });
    this.#tabSession?.on(CDPSessionEvent.Ready, session => {
      assert(session instanceof CdpCDPSession);
      if (session._target()._subtype() !== 'prerender') {
        return;
      }
      this.#frameManager.registerSpeculativeSession(session).catch(debugError);
      this.#emulationManager
        .registerSpeculativeSession(session)
        .catch(debugError);
    });
  }

  #setupEventListeners() {
    this.#client.on(CDPSessionEvent.Ready, this.#onAttachedToTarget);

    this.#target
      ._targetManager()
      .on(TargetManagerEvent.TargetGone, this.#onDetachedFromTarget);

    for (const [eventName, handler] of this.#frameManagerHandlers) {
      this.#frameManager.on(eventName, handler);
    }

    for (const [eventName, handler] of this.#networkManagerHandlers) {
      // TODO: Remove any.
      this.#frameManager.networkManager.on(eventName, handler as any);
    }

    for (const [eventName, handler] of this.#sessionHandlers) {
      // TODO: Remove any.
      this.#client.on(eventName, handler as any);
    }

    this.#target._isClosedDeferred
      .valueOrThrow()
      .then(() => {
        this.#client.off(CDPSessionEvent.Ready, this.#onAttachedToTarget);

        this.#target
          ._targetManager()
          .off(TargetManagerEvent.TargetGone, this.#onDetachedFromTarget);

        this.emit(PageEvent.Close, undefined);
        this.#closed = true;
      })
      .catch(debugError);
  }

  #onDetachedFromTarget = (target: CdpTarget) => {
    const sessionId = target._session()?.id();
    const worker = this.#workers.get(sessionId!);
    if (!worker) {
      return;
    }
    this.#workers.delete(sessionId!);
    this.emit(PageEvent.WorkerDestroyed, worker);
  };

  #onAttachedToTarget = (session: CDPSession) => {
    assert(session instanceof CdpCDPSession);
    this.#frameManager.onAttachedToTarget(session._target());
    if (session._target()._getTargetInfo().type === 'worker') {
      const worker = new WebWorker(
        session,
        session._target().url(),
        this.#addConsoleMessage.bind(this),
        this.#handleException.bind(this)
      );
      this.#workers.set(session.id(), worker);
      this.emit(PageEvent.WorkerCreated, worker);
    }
    session.on(CDPSessionEvent.Ready, this.#onAttachedToTarget);
  };

  async #initialize(): Promise<void> {
    try {
      await Promise.all([
        this.#frameManager.initialize(this.#client),
        this.#client.send('Performance.enable'),
        this.#client.send('Log.enable'),
      ]);
    } catch (err) {
      if (isErrorLike(err) && isTargetClosedError(err)) {
        debugError(err);
      } else {
        throw err;
      }
    }
  }

  async #onFileChooser(
    event: Protocol.Page.FileChooserOpenedEvent
  ): Promise<void> {
    if (!this.#fileChooserDeferreds.size) {
      return;
    }

    const frame = this.#frameManager.frame(event.frameId);
    assert(frame, 'This should never happen.');

    // This is guaranteed to be an HTMLInputElement handle by the event.
    using handle = (await frame.worlds[MAIN_WORLD].adoptBackendNode(
      event.backendNodeId
    )) as ElementHandle<HTMLInputElement>;

    const fileChooser = new FileChooser(handle.move(), event);
    for (const promise of this.#fileChooserDeferreds) {
      promise.resolve(fileChooser);
    }
    this.#fileChooserDeferreds.clear();
  }

  _client(): CDPSession {
    return this.#client;
  }

  override isServiceWorkerBypassed(): boolean {
    return this.#serviceWorkerBypassed;
  }

  override isDragInterceptionEnabled(): boolean {
    return this.#userDragInterceptionEnabled;
  }

  override isJavaScriptEnabled(): boolean {
    return this.#emulationManager.javascriptEnabled;
  }

  override async waitForFileChooser(
    options: WaitTimeoutOptions = {}
  ): Promise<FileChooser> {
    const needsEnable = this.#fileChooserDeferreds.size === 0;
    const {timeout = this.#timeoutSettings.timeout()} = options;
    const deferred = Deferred.create<FileChooser>({
      message: `Waiting for \`FileChooser\` failed: ${timeout}ms exceeded`,
      timeout,
    });
    this.#fileChooserDeferreds.add(deferred);
    let enablePromise: Promise<void> | undefined;
    if (needsEnable) {
      enablePromise = this.#client.send('Page.setInterceptFileChooserDialog', {
        enabled: true,
      });
    }
    try {
      const [result] = await Promise.all([
        deferred.valueOrThrow(),
        enablePromise,
      ]);
      return result;
    } catch (error) {
      this.#fileChooserDeferreds.delete(deferred);
      throw error;
    }
  }

  override async setGeolocation(options: GeolocationOptions): Promise<void> {
    return await this.#emulationManager.setGeolocation(options);
  }

  override target(): CdpTarget {
    return this.#target;
  }

  override browser(): Browser {
    return this.#target.browser();
  }

  override browserContext(): BrowserContext {
    return this.#target.browserContext();
  }

  #onTargetCrashed(): void {
    this.emit(PageEvent.Error, new Error('Page crashed!'));
  }

  #onLogEntryAdded(event: Protocol.Log.EntryAddedEvent): void {
    const {level, text, args, source, url, lineNumber} = event.entry;
    if (args) {
      args.map(arg => {
        return releaseObject(this.#client, arg);
      });
    }
    if (source !== 'worker') {
      this.emit(
        PageEvent.Console,
        new ConsoleMessage(level, text, [], [{url, lineNumber}])
      );
    }
  }

  override mainFrame(): CdpFrame {
    return this.#frameManager.mainFrame();
  }

  override get keyboard(): CdpKeyboard {
    return this.#keyboard;
  }

  override get touchscreen(): CdpTouchscreen {
    return this.#touchscreen;
  }

  override get coverage(): Coverage {
    return this.#coverage;
  }

  override get tracing(): Tracing {
    return this.#tracing;
  }

  override get accessibility(): Accessibility {
    return this.#accessibility;
  }

  override frames(): Frame[] {
    return this.#frameManager.frames();
  }

  override workers(): WebWorker[] {
    return Array.from(this.#workers.values());
  }

  override async setRequestInterception(value: boolean): Promise<void> {
    return await this.#frameManager.networkManager.setRequestInterception(
      value
    );
  }

  override async setBypassServiceWorker(bypass: boolean): Promise<void> {
    this.#serviceWorkerBypassed = bypass;
    return await this.#client.send('Network.setBypassServiceWorker', {bypass});
  }

  override async setDragInterception(enabled: boolean): Promise<void> {
    this.#userDragInterceptionEnabled = enabled;
    return await this.#client.send('Input.setInterceptDrags', {enabled});
  }

  override async setOfflineMode(enabled: boolean): Promise<void> {
    return await this.#frameManager.networkManager.setOfflineMode(enabled);
  }

  override async emulateNetworkConditions(
    networkConditions: NetworkConditions | null
  ): Promise<void> {
    return await this.#frameManager.networkManager.emulateNetworkConditions(
      networkConditions
    );
  }

  override setDefaultNavigationTimeout(timeout: number): void {
    this.#timeoutSettings.setDefaultNavigationTimeout(timeout);
  }

  override setDefaultTimeout(timeout: number): void {
    this.#timeoutSettings.setDefaultTimeout(timeout);
  }

  override getDefaultTimeout(): number {
    return this.#timeoutSettings.timeout();
  }

  override async queryObjects<Prototype>(
    prototypeHandle: JSHandle<Prototype>
  ): Promise<JSHandle<Prototype[]>> {
    assert(!prototypeHandle.disposed, 'Prototype JSHandle is disposed!');
    assert(
      prototypeHandle.id,
      'Prototype JSHandle must not be referencing primitive value'
    );
    const response = await this.mainFrame().client.send(
      'Runtime.queryObjects',
      {
        prototypeObjectId: prototypeHandle.id,
      }
    );
    return createCdpHandle(
      this.mainFrame().mainRealm(),
      response.objects
    ) as HandleFor<Prototype[]>;
  }

  override async cookies(
    ...urls: string[]
  ): Promise<Protocol.Network.Cookie[]> {
    const originalCookies = (
      await this.#client.send('Network.getCookies', {
        urls: urls.length ? urls : [this.url()],
      })
    ).cookies;

    const unsupportedCookieAttributes = ['priority'];
    const filterUnsupportedAttributes = (
      cookie: Protocol.Network.Cookie
    ): Protocol.Network.Cookie => {
      for (const attr of unsupportedCookieAttributes) {
        delete (cookie as unknown as Record<string, unknown>)[attr];
      }
      return cookie;
    };
    return originalCookies.map(filterUnsupportedAttributes);
  }

  override async deleteCookie(
    ...cookies: Protocol.Network.DeleteCookiesRequest[]
  ): Promise<void> {
    const pageURL = this.url();
    for (const cookie of cookies) {
      const item = Object.assign({}, cookie);
      if (!cookie.url && pageURL.startsWith('http')) {
        item.url = pageURL;
      }
      await this.#client.send('Network.deleteCookies', item);
    }
  }

  override async setCookie(
    ...cookies: Protocol.Network.CookieParam[]
  ): Promise<void> {
    const pageURL = this.url();
    const startsWithHTTP = pageURL.startsWith('http');
    const items = cookies.map(cookie => {
      const item = Object.assign({}, cookie);
      if (!item.url && startsWithHTTP) {
        item.url = pageURL;
      }
      assert(
        item.url !== 'about:blank',
        `Blank page can not have cookie "${item.name}"`
      );
      assert(
        !String.prototype.startsWith.call(item.url || '', 'data:'),
        `Data URL page can not have cookie "${item.name}"`
      );
      return item;
    });
    await this.deleteCookie(...items);
    if (items.length) {
      await this.#client.send('Network.setCookies', {cookies: items});
    }
  }

  override async exposeFunction(
    name: string,
    pptrFunction: Function | {default: Function}
  ): Promise<void> {
    if (this.#bindings.has(name)) {
      throw new Error(
        `Failed to add page binding with name ${name}: window['${name}'] already exists!`
      );
    }

    let binding: Binding;
    switch (typeof pptrFunction) {
      case 'function':
        binding = new Binding(
          name,
          pptrFunction as (...args: unknown[]) => unknown
        );
        break;
      default:
        binding = new Binding(
          name,
          pptrFunction.default as (...args: unknown[]) => unknown
        );
        break;
    }

    this.#bindings.set(name, binding);

    const expression = pageBindingInitString('exposedFun', name);
    await this.#client.send('Runtime.addBinding', {name});
    const {identifier} = await this.#client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: expression,
      }
    );

    this.#exposedFunctions.set(name, identifier);

    await Promise.all(
      this.frames().map(frame => {
        return frame.evaluate(expression).catch(debugError);
      })
    );
  }

  override async removeExposedFunction(name: string): Promise<void> {
    const exposedFun = this.#exposedFunctions.get(name);
    if (!exposedFun) {
      throw new Error(
        `Failed to remove page binding with name ${name}: window['${name}'] does not exists!`
      );
    }

    await this.#client.send('Runtime.removeBinding', {name});
    await this.removeScriptToEvaluateOnNewDocument(exposedFun);

    await Promise.all(
      this.frames().map(frame => {
        return frame
          .evaluate(name => {
            // Removes the dangling Puppeteer binding wrapper.
            // @ts-expect-error: In a different context.
            globalThis[name] = undefined;
          }, name)
          .catch(debugError);
      })
    );

    this.#exposedFunctions.delete(name);
    this.#bindings.delete(name);
  }

  override async authenticate(credentials: Credentials): Promise<void> {
    return await this.#frameManager.networkManager.authenticate(credentials);
  }

  override async setExtraHTTPHeaders(
    headers: Record<string, string>
  ): Promise<void> {
    return await this.#frameManager.networkManager.setExtraHTTPHeaders(headers);
  }

  override async setUserAgent(
    userAgent: string,
    userAgentMetadata?: Protocol.Emulation.UserAgentMetadata
  ): Promise<void> {
    return await this.#frameManager.networkManager.setUserAgent(
      userAgent,
      userAgentMetadata
    );
  }

  override async metrics(): Promise<Metrics> {
    const response = await this.#client.send('Performance.getMetrics');
    return this.#buildMetricsObject(response.metrics);
  }

  #emitMetrics(event: Protocol.Performance.MetricsEvent): void {
    this.emit(PageEvent.Metrics, {
      title: event.title,
      metrics: this.#buildMetricsObject(event.metrics),
    });
  }

  #buildMetricsObject(metrics?: Protocol.Performance.Metric[]): Metrics {
    const result: Record<
      Protocol.Performance.Metric['name'],
      Protocol.Performance.Metric['value']
    > = {};
    for (const metric of metrics || []) {
      if (supportedMetrics.has(metric.name)) {
        result[metric.name] = metric.value;
      }
    }
    return result;
  }

  #handleException(exception: Protocol.Runtime.ExceptionThrownEvent): void {
    this.emit(
      PageEvent.PageError,
      createClientError(exception.exceptionDetails)
    );
  }

  async #onConsoleAPI(
    event: Protocol.Runtime.ConsoleAPICalledEvent
  ): Promise<void> {
    if (event.executionContextId === 0) {
      // DevTools protocol stores the last 1000 console messages. These
      // messages are always reported even for removed execution contexts. In
      // this case, they are marked with executionContextId = 0 and are
      // reported upon enabling Runtime agent.
      //
      // Ignore these messages since:
      // - there's no execution context we can use to operate with message
      //   arguments
      // - these messages are reported before Puppeteer clients can subscribe
      //   to the 'console'
      //   page event.
      //
      // @see https://github.com/puppeteer/puppeteer/issues/3865
      return;
    }
    const context = this.#frameManager.getExecutionContextById(
      event.executionContextId,
      this.#client
    );
    if (!context) {
      debugError(
        new Error(
          `ExecutionContext not found for a console message: ${JSON.stringify(
            event
          )}`
        )
      );
      return;
    }
    const values = event.args.map(arg => {
      return createCdpHandle(context._world, arg);
    });
    this.#addConsoleMessage(event.type, values, event.stackTrace);
  }

  async #onBindingCalled(
    event: Protocol.Runtime.BindingCalledEvent
  ): Promise<void> {
    let payload: BindingPayload;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      // The binding was either called by something in the page or it was
      // called before our wrapper was initialized.
      return;
    }
    const {type, name, seq, args, isTrivial} = payload;
    if (type !== 'exposedFun') {
      return;
    }

    const context = this.#frameManager.executionContextById(
      event.executionContextId,
      this.#client
    );
    if (!context) {
      return;
    }

    const binding = this.#bindings.get(name);
    await binding?.run(context, seq, args, isTrivial);
  }

  #addConsoleMessage(
    eventType: ConsoleMessageType,
    args: JSHandle[],
    stackTrace?: Protocol.Runtime.StackTrace
  ): void {
    if (!this.listenerCount(PageEvent.Console)) {
      args.forEach(arg => {
        return arg.dispose();
      });
      return;
    }
    const textTokens = [];
    // eslint-disable-next-line max-len -- The comment is long.
    // eslint-disable-next-line rulesdir/use-using -- These are not owned by this function.
    for (const arg of args) {
      const remoteObject = arg.remoteObject();
      if (remoteObject.objectId) {
        textTokens.push(arg.toString());
      } else {
        textTokens.push(valueFromRemoteObject(remoteObject));
      }
    }
    const stackTraceLocations = [];
    if (stackTrace) {
      for (const callFrame of stackTrace.callFrames) {
        stackTraceLocations.push({
          url: callFrame.url,
          lineNumber: callFrame.lineNumber,
          columnNumber: callFrame.columnNumber,
        });
      }
    }
    const message = new ConsoleMessage(
      eventType,
      textTokens.join(' '),
      args,
      stackTraceLocations
    );
    this.emit(PageEvent.Console, message);
  }

  #onDialog(event: Protocol.Page.JavascriptDialogOpeningEvent): void {
    const type = validateDialogType(event.type);
    const dialog = new CdpDialog(
      this.#client,
      type,
      event.message,
      event.defaultPrompt
    );
    this.emit(PageEvent.Dialog, dialog);
  }

  override async reload(
    options?: WaitForOptions
  ): Promise<HTTPResponse | null> {
    const [result] = await Promise.all([
      this.waitForNavigation(options),
      this.#client.send('Page.reload'),
    ]);

    return result;
  }

  override async createCDPSession(): Promise<CDPSession> {
    return await this.target().createCDPSession();
  }

  override async waitForRequest(
    urlOrPredicate: string | ((req: HTTPRequest) => boolean | Promise<boolean>),
    options: {timeout?: number} = {}
  ): Promise<HTTPRequest> {
    const {timeout = this.#timeoutSettings.timeout()} = options;
    return await waitForEvent(
      this.#frameManager.networkManager,
      NetworkManagerEvent.Request,
      async request => {
        if (isString(urlOrPredicate)) {
          return urlOrPredicate === request.url();
        }
        if (typeof urlOrPredicate === 'function') {
          return !!(await urlOrPredicate(request));
        }
        return false;
      },
      timeout,
      this.#sessionCloseDeferred.valueOrThrow()
    );
  }

  override async waitForResponse(
    urlOrPredicate:
      | string
      | ((res: HTTPResponse) => boolean | Promise<boolean>),
    options: {timeout?: number} = {}
  ): Promise<HTTPResponse> {
    const {timeout = this.#timeoutSettings.timeout()} = options;
    return await waitForEvent(
      this.#frameManager.networkManager,
      NetworkManagerEvent.Response,
      async response => {
        if (isString(urlOrPredicate)) {
          return urlOrPredicate === response.url();
        }
        if (typeof urlOrPredicate === 'function') {
          return !!(await urlOrPredicate(response));
        }
        return false;
      },
      timeout,
      this.#sessionCloseDeferred.valueOrThrow()
    );
  }

  override async waitForNetworkIdle(
    options: {idleTime?: number; timeout?: number} = {}
  ): Promise<void> {
    const {idleTime = 500, timeout = this.#timeoutSettings.timeout()} = options;

    await this._waitForNetworkIdle(
      this.#frameManager.networkManager,
      idleTime,
      timeout,
      this.#sessionCloseDeferred
    );
  }

  override async goBack(
    options: WaitForOptions = {}
  ): Promise<HTTPResponse | null> {
    return await this.#go(-1, options);
  }

  override async goForward(
    options: WaitForOptions = {}
  ): Promise<HTTPResponse | null> {
    return await this.#go(+1, options);
  }

  async #go(
    delta: number,
    options: WaitForOptions
  ): Promise<HTTPResponse | null> {
    const history = await this.#client.send('Page.getNavigationHistory');
    const entry = history.entries[history.currentIndex + delta];
    if (!entry) {
      return null;
    }
    const result = await Promise.all([
      this.waitForNavigation(options),
      this.#client.send('Page.navigateToHistoryEntry', {entryId: entry.id}),
    ]);
    return result[0];
  }

  override async bringToFront(): Promise<void> {
    await this.#client.send('Page.bringToFront');
  }

  override async setJavaScriptEnabled(enabled: boolean): Promise<void> {
    return await this.#emulationManager.setJavaScriptEnabled(enabled);
  }

  override async setBypassCSP(enabled: boolean): Promise<void> {
    await this.#client.send('Page.setBypassCSP', {enabled});
  }

  override async emulateMediaType(type?: string): Promise<void> {
    return await this.#emulationManager.emulateMediaType(type);
  }

  override async emulateCPUThrottling(factor: number | null): Promise<void> {
    return await this.#emulationManager.emulateCPUThrottling(factor);
  }

  override async emulateMediaFeatures(
    features?: MediaFeature[]
  ): Promise<void> {
    return await this.#emulationManager.emulateMediaFeatures(features);
  }

  override async emulateTimezone(timezoneId?: string): Promise<void> {
    return await this.#emulationManager.emulateTimezone(timezoneId);
  }

  override async emulateIdleState(overrides?: {
    isUserActive: boolean;
    isScreenUnlocked: boolean;
  }): Promise<void> {
    return await this.#emulationManager.emulateIdleState(overrides);
  }

  override async emulateVisionDeficiency(
    type?: Protocol.Emulation.SetEmulatedVisionDeficiencyRequest['type']
  ): Promise<void> {
    return await this.#emulationManager.emulateVisionDeficiency(type);
  }

  override async setViewport(viewport: Viewport): Promise<void> {
    const needsReload = await this.#emulationManager.emulateViewport(viewport);
    this.#viewport = viewport;
    if (needsReload) {
      await this.reload();
    }
  }

  override viewport(): Viewport | null {
    return this.#viewport;
  }

  override async evaluateOnNewDocument<
    Params extends unknown[],
    Func extends (...args: Params) => unknown = (...args: Params) => unknown,
  >(
    pageFunction: Func | string,
    ...args: Params
  ): Promise<NewDocumentScriptEvaluation> {
    const source = evaluationString(pageFunction, ...args);
    const {identifier} = await this.#client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source,
      }
    );

    return {identifier};
  }

  override async removeScriptToEvaluateOnNewDocument(
    identifier: string
  ): Promise<void> {
    await this.#client.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier,
    });
  }

  override async setCacheEnabled(enabled = true): Promise<void> {
    await this.#frameManager.networkManager.setCacheEnabled(enabled);
  }

  override screenshot(
    options: ScreenshotOptions & {encoding: 'base64'}
  ): Promise<string>;
  override screenshot(
    options?: ScreenshotOptions & {encoding?: 'binary'}
  ): Promise<Buffer>;
  override async screenshot(
    options: ScreenshotOptions = {}
  ): Promise<Buffer | string> {
    let screenshotType = Protocol.Page.CaptureScreenshotRequestFormat.Png;
    // options.type takes precedence over inferring the type from options.path
    // because it may be a 0-length file with no extension created beforehand
    // (i.e. as a temp file).
    if (options.type) {
      screenshotType =
        options.type as Protocol.Page.CaptureScreenshotRequestFormat;
    } else if (options.path) {
      const filePath = options.path;
      const extension = filePath
        .slice(filePath.lastIndexOf('.') + 1)
        .toLowerCase();
      switch (extension) {
        case 'png':
          screenshotType = Protocol.Page.CaptureScreenshotRequestFormat.Png;
          break;
        case 'jpeg':
        case 'jpg':
          screenshotType = Protocol.Page.CaptureScreenshotRequestFormat.Jpeg;
          break;
        case 'webp':
          screenshotType = Protocol.Page.CaptureScreenshotRequestFormat.Webp;
          break;
        default:
          throw new Error(
            `Unsupported screenshot type for extension \`.${extension}\``
          );
      }
    }

    if (options.quality) {
      assert(
        screenshotType === Protocol.Page.CaptureScreenshotRequestFormat.Jpeg ||
          screenshotType === Protocol.Page.CaptureScreenshotRequestFormat.Webp,
        'options.quality is unsupported for the ' +
          screenshotType +
          ' screenshots'
      );
      assert(
        typeof options.quality === 'number',
        'Expected options.quality to be a number but found ' +
          typeof options.quality
      );
      assert(
        Number.isInteger(options.quality),
        'Expected options.quality to be an integer'
      );
      assert(
        options.quality >= 0 && options.quality <= 100,
        'Expected options.quality to be between 0 and 100 (inclusive), got ' +
          options.quality
      );
    }
    assert(
      !options.clip || !options.fullPage,
      'options.clip and options.fullPage are exclusive'
    );
    if (options.clip) {
      assert(
        typeof options.clip.x === 'number',
        'Expected options.clip.x to be a number but found ' +
          typeof options.clip.x
      );
      assert(
        typeof options.clip.y === 'number',
        'Expected options.clip.y to be a number but found ' +
          typeof options.clip.y
      );
      assert(
        typeof options.clip.width === 'number',
        'Expected options.clip.width to be a number but found ' +
          typeof options.clip.width
      );
      assert(
        typeof options.clip.height === 'number',
        'Expected options.clip.height to be a number but found ' +
          typeof options.clip.height
      );
      assert(
        options.clip.width !== 0,
        'Expected options.clip.width not to be 0.'
      );
      assert(
        options.clip.height !== 0,
        'Expected options.clip.height not to be 0.'
      );
    }
    return await this.#screenshotTaskQueue.postTask(() => {
      return this.#screenshotTask(screenshotType, options);
    });
  }

  async #screenshotTask(
    format: Protocol.Page.CaptureScreenshotRequestFormat,
    options: ScreenshotOptions = {}
  ): Promise<Buffer | string> {
    await this.#client.send('Target.activateTarget', {
      targetId: this.#target._targetId,
    });
    let clip = options.clip ? processClip(options.clip) : undefined;
    let captureBeyondViewport = options.captureBeyondViewport ?? true;
    const fromSurface = options.fromSurface;

    if (options.fullPage) {
      // Overwrite clip for full page.
      clip = undefined;

      if (!captureBeyondViewport) {
        const metrics = await this.#client.send('Page.getLayoutMetrics');
        // Fallback to `contentSize` in case of using Firefox.
        const {width, height} = metrics.cssContentSize || metrics.contentSize;
        const {
          isMobile = false,
          deviceScaleFactor = 1,
          isLandscape = false,
        } = this.#viewport || {};
        const screenOrientation: Protocol.Emulation.ScreenOrientation =
          isLandscape
            ? {angle: 90, type: 'landscapePrimary'}
            : {angle: 0, type: 'portraitPrimary'};
        await this.#client.send('Emulation.setDeviceMetricsOverride', {
          mobile: isMobile,
          width,
          height,
          deviceScaleFactor,
          screenOrientation,
        });
      }
    } else if (!clip) {
      captureBeyondViewport = false;
    }

    const shouldSetDefaultBackground =
      options.omitBackground && (format === 'png' || format === 'webp');
    if (shouldSetDefaultBackground) {
      await this.#emulationManager.setTransparentBackgroundColor();
    }

    const result = await this.#client.send('Page.captureScreenshot', {
      format,
      optimizeForSpeed: options.optimizeForSpeed,
      quality: options.quality,
      clip: clip && {
        ...clip,
        scale: clip.scale ?? 1,
      },
      captureBeyondViewport,
      fromSurface,
    });
    if (shouldSetDefaultBackground) {
      await this.#emulationManager.resetDefaultBackgroundColor();
    }

    if (options.fullPage && this.#viewport) {
      await this.setViewport(this.#viewport);
    }

    if (options.encoding === 'base64') {
      return result.data;
    }

    const buffer = Buffer.from(result.data, 'base64');
    await this._maybeWriteBufferToFile(options.path, buffer);

    return buffer;

    function processClip(clip: ScreenshotClip): ScreenshotClip {
      const x = Math.round(clip.x);
      const y = Math.round(clip.y);
      const width = Math.round(clip.width + clip.x - x);
      const height = Math.round(clip.height + clip.y - y);
      return {x, y, width, height, scale: clip.scale};
    }
  }

  override async createPDFStream(options: PDFOptions = {}): Promise<Readable> {
    const {
      landscape,
      displayHeaderFooter,
      headerTemplate,
      footerTemplate,
      printBackground,
      scale,
      width: paperWidth,
      height: paperHeight,
      margin,
      pageRanges,
      preferCSSPageSize,
      omitBackground,
      timeout,
    } = this._getPDFOptions(options);

    if (omitBackground) {
      await this.#emulationManager.setTransparentBackgroundColor();
    }

    const printCommandPromise = this.#client.send('Page.printToPDF', {
      transferMode: 'ReturnAsStream',
      landscape,
      displayHeaderFooter,
      headerTemplate,
      footerTemplate,
      printBackground,
      scale,
      paperWidth,
      paperHeight,
      marginTop: margin.top,
      marginBottom: margin.bottom,
      marginLeft: margin.left,
      marginRight: margin.right,
      pageRanges,
      preferCSSPageSize,
    });

    const result = await waitWithTimeout(
      printCommandPromise,
      'Page.printToPDF',
      timeout
    );

    if (omitBackground) {
      await this.#emulationManager.resetDefaultBackgroundColor();
    }

    assert(result.stream, '`stream` is missing from `Page.printToPDF');
    return await getReadableFromProtocolStream(this.#client, result.stream);
  }

  override async pdf(options: PDFOptions = {}): Promise<Buffer> {
    const {path = undefined} = options;
    const readable = await this.createPDFStream(options);
    const buffer = await getReadableAsBuffer(readable, path);
    assert(buffer, 'Could not create buffer');
    return buffer;
  }

  override async close(
    options: {runBeforeUnload?: boolean} = {runBeforeUnload: undefined}
  ): Promise<void> {
    const connection = this.#client.connection();
    assert(
      connection,
      'Protocol error: Connection closed. Most likely the page has been closed.'
    );
    const runBeforeUnload = !!options.runBeforeUnload;
    if (runBeforeUnload) {
      await this.#client.send('Page.close');
    } else {
      await connection.send('Target.closeTarget', {
        targetId: this.#target._targetId,
      });
      await this.#target._isClosedDeferred.valueOrThrow();
    }
  }

  override isClosed(): boolean {
    return this.#closed;
  }

  override get mouse(): CdpMouse {
    return this.#mouse;
  }

  /**
   * This method is typically coupled with an action that triggers a device
   * request from an api such as WebBluetooth.
   *
   * :::caution
   *
   * This must be called before the device request is made. It will not return a
   * currently active device prompt.
   *
   * :::
   *
   * @example
   *
   * ```ts
   * const [devicePrompt] = Promise.all([
   *   page.waitForDevicePrompt(),
   *   page.click('#connect-bluetooth'),
   * ]);
   * await devicePrompt.select(
   *   await devicePrompt.waitForDevice(({name}) => name.includes('My Device'))
   * );
   * ```
   */
  override async waitForDevicePrompt(
    options: WaitTimeoutOptions = {}
  ): Promise<DeviceRequestPrompt> {
    return await this.mainFrame().waitForDevicePrompt(options);
  }
}

const supportedMetrics = new Set<string>([
  'Timestamp',
  'Documents',
  'Frames',
  'JSEventListeners',
  'Nodes',
  'LayoutCount',
  'RecalcStyleCount',
  'LayoutDuration',
  'RecalcStyleDuration',
  'ScriptDuration',
  'TaskDuration',
  'JSHeapUsedSize',
  'JSHeapTotalSize',
]);
