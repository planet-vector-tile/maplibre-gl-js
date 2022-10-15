import WorkerTile from './worker_tile';
import { extend } from '../util/util';
import { PlanetVectorTile } from 'planet-vector-tile/dist/planet-vector-tile';

import type {
    WorkerSource,
    WorkerTileParameters,
    WorkerTileCallback,
    TileParameters,
    WorkerTileResult,
} from '../source/worker_source';

import type Actor from '../util/actor';
import type StyleLayerIndex from '../style/style_layer_index';

import vtpbf from 'vt-pbf';

// import planetPlugin, { Planet } from 'planet-vector-tile'

export default class VectorTileWorkerSource implements WorkerSource {
    actor: Actor;
    layerIndex: StyleLayerIndex;
    availableImages: Array<string>;
    loaded: { [_: string]: WorkerTile };
    // planet: Planet;

    constructor(actor: Actor, layerIndex: StyleLayerIndex, availableImages: Array<string>) {
        this.actor = actor;
        this.layerIndex = layerIndex;
        this.availableImages = availableImages;
        this.loaded = {};
        // this.planet = planetPlugin.loadPlanet('fromworker', 0, 14);
    }

    loadTile(params: WorkerTileParameters, callback: WorkerTileCallback) {
        const workerTile = new WorkerTile(params);

        // No request to cancel.
        workerTile.abort = () => {};

        // this.planet.tile()


        // it's an array, not ArrayBuffer, figure this out...
        const pvt = new PlanetVectorTile(params.tileBuffer);

        console.log('pvt tile properties', pvt.layers.tile_info.feature(0).properties)
        console.log('pvt tile pointss', pvt.layers.tile_info.feature(0).loadGeometry())
        debugger;


        // Create actual MapboxVectorTile protocol buffer for internal use.
        // Can we avoid this?
        const pbf: Uint8Array = vtpbf(pvt);
        const mvtBuffer = pbf.buffer;

        workerTile.vectorTile = pvt;
        workerTile.parse(pvt, this.layerIndex, this.availableImages, this.actor, (err, result) => {
            if (err) return callback(err);

            // Transferring a copy of rawTileData because the worker needs to retain its copy.
            // Really?
            const workerTileResult: WorkerTileResult = extend({ rawTileData: mvtBuffer.slice(0) }, result);
            callback(null, workerTileResult);
        });

        this.loaded = this.loaded || {};
        this.loaded[params.uid] = workerTile;
    }

    reloadTile(params: WorkerTileParameters, callback: WorkerTileCallback) {
        const loaded = this.loaded;
        const uid = params.uid;
        const self = this;
        if (loaded && loaded[uid]) {
            const workerTile = loaded[uid];
            workerTile.showCollisionBoxes = params.showCollisionBoxes;

            const done = (err?: Error, data?: any) => {
                const reloadCallback = workerTile.reloadCallback;
                if (reloadCallback) {
                    delete workerTile.reloadCallback;
                    workerTile.parse(
                        workerTile.vectorTile,
                        self.layerIndex,
                        this.availableImages,
                        self.actor,
                        reloadCallback
                    );
                }
                callback(err, data);
            };

            if (workerTile.status === 'parsing') {
                workerTile.reloadCallback = done;
            } else if (workerTile.status === 'done') {
                // if there was no vector tile data on the initial load, don't try and re-parse tile
                if (workerTile.vectorTile) {
                    workerTile.parse(workerTile.vectorTile, this.layerIndex, this.availableImages, this.actor, done);
                } else {
                    done();
                }
            }
        }
    }

    abortTile(params: TileParameters, callback: WorkerTileCallback) {
        // There is no request to abort
        callback();
    }

    removeTile(params: TileParameters, callback: WorkerTileCallback) {
        const loaded = this.loaded;
        const uid = params.uid;
        if (loaded && loaded[uid]) {
            delete loaded[uid];
        }
        callback();
    }
}
