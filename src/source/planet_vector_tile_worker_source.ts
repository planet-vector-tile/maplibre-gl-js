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

export default class PlanetVectorTileWorkerSource implements WorkerSource {
    actor: Actor;
    layerIndex: StyleLayerIndex;
    availableImages: Array<string>;
    loaded: { [_: string]: WorkerTile };

    constructor(actor: Actor, layerIndex: StyleLayerIndex, availableImages: Array<string>) {
        this.actor = actor;
        this.layerIndex = layerIndex;
        this.availableImages = availableImages;
        this.loaded = {};
    }

    loadTile(params: WorkerTileParameters, callback: WorkerTileCallback) {
        const workerTile = new WorkerTile(params);

        // No request to cancel.
        workerTile.abort = () => {};

        const pvt = new PlanetVectorTile(params.tileBuffer);

        // NHTODO GeoJSON recreates a PBF. This adds quite a lot to memory usage.
        // This is needed for feature selection to work.
        const pbf: Uint8Array = vtpbf(pvt);

        // workerTile.vectorTile = pvt;
        workerTile.parse(pvt, this.layerIndex, this.availableImages, this.actor, (err, result) => {
            if (err) return callback(err);

            result.rawTileData = pbf.buffer;
            callback(null, result);
        });

        this.loaded = this.loaded || {};
        this.loaded[params.uid] = workerTile;
    }

    reloadTile(params: WorkerTileParameters, callback: WorkerTileCallback) {
        console.log('PVT reloadTile');
        debugger;
        
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
