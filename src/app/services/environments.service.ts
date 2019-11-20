
import { Injectable } from '@angular/core';
import { clipboard, remote } from 'electron';
import * as storage from 'electron-json-storage';
import * as fs from 'fs';
import { cloneDeep } from 'lodash';
import { debounceTime, filter, first } from 'rxjs/operators';
import { AnalyticsEvents } from 'src/app/enums/analytics-events.enum';
import { Errors } from 'src/app/enums/errors.enum';
import { Messages } from 'src/app/enums/messages.enum';
import { Migrations } from 'src/app/libs/migrations.lib';
import { DataService } from 'src/app/services/data.service';
import { EventsService } from 'src/app/services/events.service';
import { OpenAPIConverterService } from 'src/app/services/openapi-converter.service';
import { ServerService } from 'src/app/services/server.service';
import { SettingsService } from 'src/app/services/settings.service';
import { ToastsService } from 'src/app/services/toasts.service';
import { addEnvironmentAction, addRouteAction, addRouteResponseAction, moveEnvironmentsAction, moveRouteResponsesAction, moveRoutesAction, navigateEnvironmentsAction, navigateRoutesAction, removeEnvironmentAction, removeRouteAction, removeRouteResponseAction, setActiveEnvironmentAction, setActiveEnvironmentLogTabAction, setActiveRouteAction, setActiveRouteResponseAction, setActiveTabAction, setActiveViewAction, setInitialEnvironmentsAction, updateEnvironmentAction, updateRouteAction, updateRouteResponseAction } from 'src/app/stores/actions';
import { ReducerDirectionType } from 'src/app/stores/reducer';
import { EnvironmentLogsTabsNameType, Store, TabsNameType, ViewsNameType } from 'src/app/stores/store';
import { DataSubjectType, ExportType } from 'src/app/types/data.type';
import { Environment, EnvironmentProperties, Environments } from 'src/app/types/environment.type';
import { CORSHeaders, Header, Method, Route, RouteProperties, RouteResponse, RouteResponseProperties } from 'src/app/types/route.type';
import { dragulaNamespaces } from 'src/app/types/ui.type';
import * as uuid from 'uuid/v1';

const appVersion = require('../../../package.json').version;

@Injectable()
export class EnvironmentsService {
  private dialog = remote.dialog;
  private BrowserWindow = remote.BrowserWindow;
  private environmentSchema: Environment = {
    uuid: '',
    name: '',
    endpointPrefix: '',
    latency: 0,
    port: 3000,
    routes: [],
    proxyMode: false,
    proxyHost: '',
    https: false,
    cors: true,
    headers: []
  };

  private routeSchema: Route = {
    uuid: '',
    documentation: '',
    method: 'get',
    endpoint: '',
    responses: [],
    enabled: true
  };

  private routeResponseSchema: RouteResponse = {
    uuid: '',
    body: '{}',
    latency: 0,
    statusCode: '200',
    label: '',
    headers: [
      { key: '', value: '' }
    ],
    filePath: '',
    sendFileAsBody: false,
    rules: []
  };

  private emptyHeaderSchema: Header = { key: '', value: '' };
  private storageKey = 'environments';

  constructor(
    private toastService: ToastsService,
    private dataService: DataService,
    private eventsService: EventsService,
    private settingsService: SettingsService,
    private store: Store,
    private serverService: ServerService,
    private openapiConverterService: OpenAPIConverterService
  ) {
    // get existing environments from storage or default one
    storage.get(this.storageKey, (_error: any, environments: Environment[]) => {
      // if empty object build default starting env
      if (Object.keys(environments).length === 0 && environments.constructor === Object) {
        this.store.update(setInitialEnvironmentsAction([this.buildDefaultEnvironment()]));
      } else {
        // wait for settings to be ready before migrating and loading envs
        this.store.select('settings').pipe(
          filter(Boolean),
          first()
        ).subscribe(() => {
          this.store.update(setInitialEnvironmentsAction(this.migrateData(environments)));
        });
      }
    });

    // subscribe to environments update to save
    this.store.select('environments').pipe(debounceTime(2000)).subscribe((environments) => {
      storage.set(this.storageKey, environments);
    });
  }

  /**
   * Set active environment by UUID or navigation
   */
  public setActiveEnvironment(environmentUUIDOrDirection: string | ReducerDirectionType) {
    if (this.store.get('activeEnvironmentUUID') !== environmentUUIDOrDirection) {
      if (environmentUUIDOrDirection === 'next' || environmentUUIDOrDirection === 'previous') {
        this.store.update(navigateEnvironmentsAction(environmentUUIDOrDirection));
      } else {
        this.store.update(setActiveEnvironmentAction(environmentUUIDOrDirection));
      }

      this.eventsService.analyticsEvents.next(AnalyticsEvents.NAVIGATE_ENVIRONMENT);
    }
  }

  /**
   * Set active route by UUID or navigation
   */
  public setActiveRoute(routeUUIDOrDirection: string | ReducerDirectionType) {
    if (this.store.get('activeRouteUUID') !== routeUUIDOrDirection) {
      if (routeUUIDOrDirection === 'next' || routeUUIDOrDirection === 'previous') {
        this.store.update(navigateRoutesAction(routeUUIDOrDirection));
      } else {
        this.store.update(setActiveRouteAction(routeUUIDOrDirection));
      }

      this.eventsService.analyticsEvents.next(AnalyticsEvents.NAVIGATE_ROUTE);
    }
  }

  /**
   * Add a new environment and save it in the store
   */
  public addEnvironment() {
    this.store.update(addEnvironmentAction(this.buildNewEnvironment()));
    this.eventsService.analyticsEvents.next(AnalyticsEvents.CREATE_ENVIRONMENT);
  }

  /**
   * Duplicate an environment, or the active environment and append it at the end of the list.
   */
  public duplicateEnvironment(environmentUUID?: string) {
    let environmentToDuplicate = this.store.getActiveEnvironment();

    if (environmentUUID) {
      environmentToDuplicate = this.store.get('environments').find(environment => environment.uuid === environmentUUID);
    }

    if (environmentToDuplicate) {
      // copy the environment, reset some properties and change name
      let newEnvironment: Environment = {
        ...cloneDeep(environmentToDuplicate),
        name: `${environmentToDuplicate.name} (copy)`
      };

      newEnvironment = this.renewUUIDs(newEnvironment, 'environment') as Environment;

      newEnvironment.port = this.getNewEnvironmentPort();

      this.store.update(addEnvironmentAction(newEnvironment));

      this.eventsService.analyticsEvents.next(AnalyticsEvents.DUPLICATE_ENVIRONMENT);
    }
  }

  /**
   * Remove an environment or the current one if not environmentUUID is provided
   */
  public removeEnvironment(environmentUUID?: string) {
    const currentEnvironmentUUID = this.store.get('activeEnvironmentUUID');

    if (!environmentUUID) {
      if (!currentEnvironmentUUID) {
        return;
      }
      environmentUUID = this.store.get('activeEnvironmentUUID');
    }

    this.serverService.stop(environmentUUID);

    this.store.update(removeEnvironmentAction(environmentUUID));

    this.eventsService.analyticsEvents.next(AnalyticsEvents.DELETE_ENVIRONMENT);
  }

  /**
   * Add a new route and save it in the store
   */
  public addRoute() {
    const newRoute: Route = {
      ...this.routeSchema,
      uuid: uuid(),
      responses: [
        {
          ...this.routeResponseSchema,
          uuid: uuid()
        }
      ]
    };

    this.store.update(addRouteAction(newRoute));
    this.eventsService.analyticsEvents.next(AnalyticsEvents.CREATE_ROUTE);
  }

  /**
   * Add a new route response and save it in the store
   */
  public addRouteResponse() {
    const newRouteResponse: RouteResponse = {
      ...this.routeResponseSchema,
      uuid: uuid()
    };

    this.store.update(addRouteResponseAction(newRouteResponse));
    this.eventsService.analyticsEvents.next(AnalyticsEvents.CREATE_ROUTE_RESPONSE);
  }

  /**
   * Duplicate a route, or the current active route and append it at the end
   */
  public duplicateRoute(routeUUID?: string) {
    let routeToDuplicate = this.store.getActiveRoute();

    if (routeUUID) {
      routeToDuplicate = this.store.getActiveEnvironment().routes.find(route => route.uuid === routeUUID);
    }

    if (routeToDuplicate) {
      let newRoute: Route = cloneDeep(routeToDuplicate);

      newRoute = this.renewUUIDs(newRoute, 'route') as Route;

      this.store.update(addRouteAction(newRoute));

      this.eventsService.analyticsEvents.next(AnalyticsEvents.DUPLICATE_ROUTE);
    }
  }

  /**
   * Remove a route and save
   */
  public removeRoute(routeUUID: string = this.store.get('activeRouteUUID')) {
    this.store.update(removeRouteAction(routeUUID));

    this.eventsService.analyticsEvents.next(AnalyticsEvents.DELETE_ROUTE);
  }

  /**
   * Remove current route response and save
   */
  public removeRouteResponse() {
    this.store.update(removeRouteResponseAction());

    this.eventsService.analyticsEvents.next(AnalyticsEvents.DELETE_ROUTE_RESPONSE);
  }

  /**
   * Enable and disable a route
   */
  public toggleRoute(routeUUID?: string) {
    const selectedRoute = this.store.getActiveEnvironment().routes.find(route => route.uuid === routeUUID);
    if (selectedRoute) {
      this.store.update(updateRouteAction({
        uuid: selectedRoute.uuid,
        enabled: !selectedRoute.enabled
      }));
    }
  }

  /**
   * Set active tab
   */
  public setActiveTab(activeTab: TabsNameType) {
    this.store.update(setActiveTabAction(activeTab));
  }

  /**
   * Set active environment logs tab
   */
  public setActiveEnvironmentLogTab(activeTab: EnvironmentLogsTabsNameType) {
    this.store.update(setActiveEnvironmentLogTabAction(activeTab));
  }

  /**
   * Set active view
   */
  public setActiveView(activeView: ViewsNameType) {
    this.store.update(setActiveViewAction(activeView));
  }

  /**
   * Set active view
   */
  public setActiveRouteResponse(routeResponseUUID: string) {
    this.store.update(setActiveRouteResponseAction(routeResponseUUID));
  }

  /**
   * Update the active environment
   */
  public updateActiveEnvironment(properties: EnvironmentProperties) {
    this.store.update(updateEnvironmentAction(properties));
  }

  /**
   * Update the active route
   */
  public updateActiveRoute(properties: RouteProperties) {
    this.store.update(updateRouteAction(properties));
  }

  /**
   * Update the active route response
   */
  public updateActiveRouteResponse(properties: RouteResponseProperties) {
    this.store.update(updateRouteResponseAction(properties));
  }

  /**
   * Start / stop active environment
   */
  public toggleActiveEnvironment() {
    const activeEnvironment = this.store.getActiveEnvironment();
    const environmentsStatus = this.store.get('environmentsStatus');
    const activeEnvironmentState = environmentsStatus[activeEnvironment.uuid];

    if (activeEnvironmentState.running) {
      this.serverService.stop(activeEnvironment.uuid);

      this.eventsService.analyticsEvents.next(AnalyticsEvents.SERVER_STOP);

      if (activeEnvironmentState.needRestart) {
        this.serverService.start(activeEnvironment);
        this.eventsService.analyticsEvents.next(AnalyticsEvents.SERVER_RESTART);
      }
    } else {
      this.serverService.start(activeEnvironment);
      this.eventsService.analyticsEvents.next(AnalyticsEvents.SERVER_START);
    }
  }

  /**
   * Build a new environment
   */
  private buildNewEnvironment(): Environment {
    return {
      ...this.environmentSchema,
      uuid: uuid(),
      name: 'New environment',
      port: this.getNewEnvironmentPort(),
      routes: [
        {
          ...this.routeSchema,
          uuid: uuid(),
          responses: [
            {
              ...this.routeResponseSchema,
              uuid: uuid()
            }
          ]
        }
      ],
      headers: [{ key: 'Content-Type', value: 'application/json' }]
    };
  }

  /**
   * Build a default environment when starting the application for the first time
   */
  private buildDefaultEnvironment(): Environment {
    return {
      ...this.environmentSchema,
      uuid: uuid(),
      name: 'Example',
      headers: [{ ...this.emptyHeaderSchema }],
      routes: [
        {
          ...this.routeSchema,
          uuid: uuid(),
          endpoint: 'answer',
          responses: [
            {
              uuid: uuid(),
              statusCode: '200',
              label: '',
              latency: 0,
              filePath: '',
              sendFileAsBody: false,
              headers: [{ key: 'Content-Type', value: 'text/plain' }],
              body: '42',
              rules: []
            }
          ]
        },
        {
          ...this.routeSchema,
          uuid: uuid(),
          method: 'post',
          endpoint: 'dolphins',
          responses: [
            {
              uuid: uuid(),
              statusCode: '200',
              label: '',
              latency: 0,
              filePath: '',
              sendFileAsBody: false,
              headers: [{ key: 'Content-Type', value: 'application/json' }],
              body: '{\n    "response": "So Long, and Thanks for All the Fish"\n}',
              rules: []
            }
          ]
        }
      ]
    };
  }

  /**
   * Migrate data after loading if needed.
   * This cumulate all versions migration
   *
   * @param environments - environments to migrate
   */
  private migrateData(environments: Environments) {
    let wasUpdated = false;
    let lastMigrationId;

    Migrations.forEach(migration => {
      if (migration.id > this.store.get('settings').lastMigration) {
        lastMigrationId = migration.id;

        environments.forEach(environment => migration.migrationFunction(environment));
        wasUpdated = true;
      }
    });

    if (wasUpdated) {
      // save last migration in the settings
      this.settingsService.updateSettings({ lastMigration: lastMigrationId });
    }

    return environments;
  }

  /**
   * Renew all environments UUIDs
   *
   * @param data
   * @param subject
   */
  private renewUUIDs(data: Environments | Environment | Route, subject: DataSubjectType) {
    if (subject === 'full') {
      (data as Environments).forEach(environment => {
        this.renewUUIDs(environment, 'environment');
      });
    } else if (subject === 'environment') {
      (data as Environment).uuid = uuid();
      (data as Environment).routes.forEach(route => {
        this.renewUUIDs(route, 'route');
      });
    } else if (subject === 'route') {
      (data as Route).uuid = uuid();
      (data as Route).responses.forEach(routeResponse => {
        routeResponse.uuid = uuid();
      });
    }

    return data;
  }

  /**
   * Move a menu item (envs / routes)
   */
  public moveMenuItem(type: dragulaNamespaces, sourceIndex: number, targetIndex: number) {
    const storeActions = {
      routes: moveRoutesAction,
      environments: moveEnvironmentsAction,
      routeResponses: moveRouteResponsesAction
    };

    this.store.update(storeActions[type]({ sourceIndex, targetIndex }));
  }

  /**
   * Export all envs in a json file
   */
  public async exportAllEnvironments() {
    const environments = this.store.get('environments');

    const dialogResult = await this.dialog.showSaveDialog(this.BrowserWindow.getFocusedWindow(), { filters: [{ name: 'JSON', extensions: ['json'] }] });

    // If the user clicked 'cancel'
    if (dialogResult.filePath === undefined) {
      return;
    }

    // reset environments before exporting
    const dataToExport = cloneDeep(environments);

    try {
      fs.writeFile(dialogResult.filePath, this.dataService.wrapExport(dataToExport, 'full'), (error) => {
        if (error) {
          this.toastService.addToast('error', Errors.EXPORT_ERROR);
        } else {
          this.toastService.addToast('success', Messages.EXPORT_SUCCESS);

          this.eventsService.analyticsEvents.next(AnalyticsEvents.EXPORT_FILE);
        }
      });
    } catch (error) {
      this.toastService.addToast('error', Errors.EXPORT_ERROR);
    }
  }

  /**
   * Export an environment to the clipboard
   *
   * @param environmentUUID
   */
  public exportEnvironmentToClipboard(environmentUUID: string) {
    const environment = this.store.getEnvironmentByUUID(environmentUUID);

    try {
      clipboard.writeText(this.dataService.wrapExport(cloneDeep(environment), 'environment'));
      this.toastService.addToast('success', Messages.EXPORT_ENVIRONMENT_CLIPBOARD_SUCCESS);
      this.eventsService.analyticsEvents.next(AnalyticsEvents.EXPORT_CLIPBOARD);
    } catch (error) {
      this.toastService.addToast('error', Errors.EXPORT_ENVIRONMENT_CLIPBOARD_ERROR);
    }
  }

  /**
   * Export a route from the active environment to the clipboard
   *
   * @param routeUUID
   */
  public exportRouteToClipboard(routeUUID: string) {
    const environment = this.store.getActiveEnvironment();

    try {
      clipboard.writeText(this.dataService.wrapExport(environment.routes.find(route => route.uuid === routeUUID), 'route'));
      this.toastService.addToast('success', Messages.EXPORT_ROUTE_CLIPBOARD_SUCCESS);
      this.eventsService.analyticsEvents.next(AnalyticsEvents.EXPORT_CLIPBOARD);
    } catch (error) {
      this.toastService.addToast('error', Errors.EXPORT_ROUTE_CLIPBOARD_ERROR);
    }
  }

  /**
   * Import an environment / route from clipboard
   * Append environment, append route in currently selected environment
   */
  public importFromClipboard() {
    let importData: ExportType;

    try {
      importData = JSON.parse(clipboard.readText());

      // verify data checksum
      if (!this.dataService.verifyImportChecksum(importData)) {
        this.toastService.addToast('error', Errors.IMPORT_CLIPBOARD_WRONG_CHECKSUM);

        return;
      }

      // verify version compatibility
      if (importData.appVersion !== appVersion) {
        this.toastService.addToast('error', Errors.IMPORT_WRONG_VERSION);

        return;
      }

      if (importData.subject === 'environment') {
        importData.data = this.renewUUIDs(importData.data as Environment, 'environment');
        this.store.update(addEnvironmentAction(importData.data as Environment));
      } else if (importData.subject === 'route') {
        importData.data = this.renewUUIDs(importData.data as Route, 'route');

        // if has a current environment append imported route
        if (this.store.get('activeEnvironmentUUID')) {
          this.store.update(addRouteAction(importData.data as Route));
        } else {
          const newEnvironment: Environment = {
            ...this.buildNewEnvironment(),
            routes: [importData.data as Route]
          };

          this.store.update(addEnvironmentAction(newEnvironment));
        }
      }

      this.eventsService.analyticsEvents.next(AnalyticsEvents.IMPORT_CLIPBOARD);
    } catch (error) {
      if (!importData) {
        this.toastService.addToast('error', Errors.IMPORT_CLIPBOARD_WRONG_CHECKSUM);

        return;
      }

      if (importData.subject === 'environment') {
        this.toastService.addToast('error', Errors.IMPORT_ENVIRONMENT_CLIPBOARD_ERROR);
      } else if (importData.subject === 'route') {
        this.toastService.addToast('error', Errors.IMPORT_ROUTE_CLIPBOARD_ERROR);
      }
    }
  }

  /**
   * Import a json environments file in Mockoon's format.
   * Verify checksum and migrate data.
   *
   * Append imported envs to the env array.
   */
  public async importEnvironmentsFile() {
    const dialogResult = await this.dialog.showOpenDialog(this.BrowserWindow.getFocusedWindow(), { filters: [{ name: 'JSON', extensions: ['json'] }] });

    if (dialogResult.filePaths && dialogResult.filePaths[0]) {
      fs.readFile(dialogResult.filePaths[0], 'utf-8', (error, fileContent) => {
        if (error) {
          this.toastService.addToast('error', Errors.IMPORT_ERROR);
        } else {
          const importData: ExportType = JSON.parse(fileContent);

          // verify data checksum
          if (!this.dataService.verifyImportChecksum(importData)) {
            this.toastService.addToast('error', Errors.IMPORT_FILE_WRONG_CHECKSUM);

            return;
          }

          // verify version compatibility
          if (importData.appVersion !== appVersion) {
            this.toastService.addToast('error', Errors.IMPORT_WRONG_VERSION);

            return;
          }

          importData.data = this.renewUUIDs(importData.data as Environments, 'full');
          (importData.data as Environments).forEach(environment => {
            this.store.update(addEnvironmentAction(environment));
          });

          this.eventsService.analyticsEvents.next(AnalyticsEvents.IMPORT_FILE);
        }
      });
    }
  }

  /**
   * Check if active environment has headers
   */
  public hasEnvironmentHeaders() {
    const activeEnvironment = this.store.getActiveEnvironment();

    return activeEnvironment && activeEnvironment.headers.some(header => !!header.key);
  }

  /**
   * Emit an headers injection event in order to add CORS headers to the headers list component
   */
  public setEnvironmentCORSHeaders() {
    this.eventsService.injectHeaders.emit({ target: 'environmentHeaders', headers: CORSHeaders });
  }

  /**
   * Create a route based on a environment log entry
   */
  public createRouteFromLog(logUUID?: string) {
    const environmentsLogs = this.store.get('environmentsLogs');
    const uuidEnvironment = this.store.get('activeEnvironmentUUID');
    const log = environmentsLogs[uuidEnvironment].find(environmentLog => environmentLog.uuid === logUUID);

    if (log) {
      let response: RouteResponse;
      if (log.response) {
        const headers: Header[] = [];
        log.response.headers.forEach(element => {
          headers.push({
            key: element.name,
            value: element.value
          });
        });
        response = {
          headers: headers,
          statusCode: log.response.status.toString(),
          label: '',
          body: log.response.body,
          rules: [],
          latency: 0,
          sendFileAsBody: false,
          filePath: null,
          uuid: uuid()
        };
      } else {
        response = {
          headers: [],
          statusCode: '200',
          label: '',
          body: '{}',
          rules: [],
          latency: 0,
          sendFileAsBody: false,
          filePath: null,
          uuid: uuid()
        };
      }

      const newRoute: Route = {
        uuid: uuid(),
        documentation: '',
        method: log.method.toLowerCase() as Method,
        endpoint: log.url.slice(1), // Remove the initial slash '/'
        responses: [response],
        enabled: true
      };
      this.store.update(addRouteAction(newRoute));

      this.eventsService.analyticsEvents.next(AnalyticsEvents.CREATE_ROUTE_FROM_LOG);
    }
  }


  /**
   * Generate a unused port to a new environment
   */
  public getNewEnvironmentPort(): number {
    const usedPorts = this.store.getEnvironmentsPorts();

    const activeEnvironment: Environment = this.store.getActiveEnvironment();
    let testSelectedPort: number;
    if (activeEnvironment == null) {
      testSelectedPort = 3000;
    } else {
      testSelectedPort = activeEnvironment.port + 1;
    }

    for (let i = 0; i < 10; i++) {
      if (testSelectedPort >= 65535) {
        break;
      } else if (!usedPorts.includes(testSelectedPort)) {
        return testSelectedPort;
      }
      testSelectedPort++;
    }

    const min = Math.ceil(1024);
    const max = Math.floor(65535);
    do {
      testSelectedPort = Math.floor(Math.random() * (max - min)) + min;
    } while (usedPorts.includes(testSelectedPort));

    return testSelectedPort;
  }

  /**
   * Import an OpenAPI (v2/v3) file in Mockoon's format.
   * Append imported envs to the env array.
   */
  public async importOpenAPIFile() {
    const dialogResult = await this.dialog.showOpenDialog(this.BrowserWindow.getFocusedWindow(), { filters: [{ name: 'OpenAPI v2/v3', extensions: ['yaml', 'json'] }] });

    if (dialogResult.filePaths && dialogResult.filePaths[0]) {
      const environment = await this.openapiConverterService.import(dialogResult.filePaths[0], this.getNewEnvironmentPort());

      console.log(environment)
      this.store.update(addEnvironmentAction(environment));
    }
  }

  /**
   * Export all environments to an OpenAPI v3 file
   */
  public exportOpenAPIFile() {

  }
}
