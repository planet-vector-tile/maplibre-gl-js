import WorkerTile from './worker_tile';
import { PVT } from 'planet-vector-tile/dist/pvt';

import type {
    WorkerSource,
    WorkerTileParameters,
    WorkerTileCallback,
    TileParameters,
} from '../source/worker_source';

import type Actor from '../util/actor';
import type StyleLayerIndex from '../style/style_layer_index';

export default class PlanetVectorTileWorkerSource implements WorkerSource {
    actor: Actor;
    layerIndex: StyleLayerIndex;
    availableImages: Array<string>;
    loading: { [_: string]: WorkerTile };
    loaded: { [_: string]: WorkerTile };
    loadPlanet: any;
    planet: any | null;

    constructor(actor: Actor, layerIndex: StyleLayerIndex, availableImages: Array<string>) {
        this.actor = actor;
        this.layerIndex = layerIndex;
        this.availableImages = availableImages;
        this.loading = {};
        this.loaded = {};

        const plugin = require('../index');
        this.loadPlanet = plugin.loadPlanet;
    }

    loadTile(params: WorkerTileParameters, callback: WorkerTileCallback) {
        const uid = params.uid;

        if (!this.planet) {
            this.planet = this.loadPlanet(params.pvtSources);
        }

        const workerTile = this.loading[uid] = new WorkerTile(params);

        let {z, x, y} = params.tileID.canonical;
        this.planet.tile(z, x, y).then(buf => {
            delete this.loading[uid];

            if (!buf) {
                return callback();
            }

            const pvt = new PVT(buf);
            workerTile.vectorTile = pvt;

            workerTile.parse(pvt, this.layerIndex, this.availableImages, this.actor, (err, result) => {
                if (err) return callback(err);
                callback(null, result);
            });
    
            this.loaded[params.uid] = workerTile;
            
        }).catch(err => {
            console.error(`Unable to load tile from planet. ${z}/${x}/${y}`, e);

            workerTile.status = 'done';
            this.loaded[uid] = workerTile;
            return callback(err);
        });

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
