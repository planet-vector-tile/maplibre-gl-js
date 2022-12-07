import { VectorSourceSpecification } from '../style-spec/types.g';
import { Callback } from '../types/callback';
import type Map from '../ui/map';
import Dispatcher from '../util/dispatcher';
import { cacheEntryPossiblyAdded } from '../util/tile_request_cache';
import { Event, Evented } from '../util/evented';
import { extend, pick } from '../util/util';
import { Source } from './source';
import Tile from './tile';
import TileBounds from './tile_bounds';
import { CanonicalTileID, OverscaledTileID } from './tile_id';

/**
 * Everything in this file is executed on the main thread.
 */

export interface PlanetPlugin {
    loadPlanet(options: object): any;
    onTileLoad(tile: CanonicalTileID, buf: any): void;
}

let planetPlugin: PlanetPlugin = null;

export function setPlanetVectorTilePlugin(plugin: PlanetPlugin) {
    planetPlugin = plugin;
}

export default class PlanetVectorTileSource extends Evented implements Source {
    planet: any | null;
    type: 'planet';
    id: string;
    minzoom: number;
    maxzoom: number;
    evenOnly: boolean;
    tileSize: number;
    isTileClipped: boolean;
    reparseOverscaled: boolean;

    _options: VectorSourceSpecification;
    dispatcher: Dispatcher;
    map: Map;
    bounds: [number, number, number, number];

    // url: string is omitted, because we don't need TileJSON

    // This is the arr
    tiles: Array<string>;
    tileBounds: TileBounds;
    _loaded: boolean;

    // Note: Not using promoteId, since we have full control of our source data.

    constructor(id: string, options: VectorSourceSpecification, dispatcher: Dispatcher, eventedParent: Evented) {
        super();
        this.planet = null;
        this.id = id;
        this.dispatcher = dispatcher;
        this.type = 'planet';
        this.minzoom = 0;
        this.maxzoom = 22;
        this.evenOnly = true;
        this.tileSize = 512;

        // Experiment with supporting larger tile sizes?
        if (this.tileSize !== 512) {
            throw new Error('vector tile sources must have a tileSize of 512');
        }

        // Should this be true? It is true for GeoJSON and MVT.
        this.reparseOverscaled = true;

        // According to interface Source, `false` if tiles can be drawn outside their
        // boundaries, `true` if they cannot.
        // Feature selection does not work for geometries outside of their origin tile,
        // so it is best to keep this off.
        this.isTileClipped = false;

        extend(this, pick(options, ['tileSize']));
        this._options = extend({ type: 'planet' }, options);

        this._loaded = false;

        this.setEventedParent(eventedParent);
    }

    // VectorTileSource has additional logic for loading TileJSON. We probably don't need that.
    load() {
        if (!planetPlugin) {
            throw new Error('The PlanetVectorTile plugin has not been loaded! Cannot load planet source.');
        }

        extend(this, pick(this._options, ['tiles', 'minzoom', 'maxzoom', 'bounds', 'tileSize']));
        if (this.bounds) {
            this.tileBounds = new TileBounds(this.bounds, this.minzoom, this.maxzoom);
        }

        if (!this.tiles || this.tiles.length < 1) {
            throw new Error('We need at least one tile URL in the PlanetVectorTile source.');
        }

        console.log('this._options', this._options);
        this.planet = planetPlugin.loadPlanet(this._options.tiles);

        this.fire(new Event('data', { dataType: 'source', sourceDataType: 'metadata' }));
        this.fire(new Event('data', { dataType: 'source', sourceDataType: 'content' }));
        this._loaded = true;
    }

    loaded(): boolean {
        return this._loaded;
    }

    hasTile(tileID: OverscaledTileID) {
        return !this.tileBounds || this.tileBounds.contains(tileID.canonical);
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
    }

    setSourceProperty(callback: Function) {
        // VectorTileSource would also cancel _tileJSONRequest
        callback();
        this.load();
    }

    setTiles(tiles: Array<string>) {
        this.setSourceProperty(() => {
            this._options.tiles = tiles;
        });

        return this;
    }

    // Omit setUrl

    // Omit onRemove

    serialize() {
        return extend({}, this._options);
    }

    loadTile(tile: Tile, callback: Callback<void>) {
        if (!planetPlugin) {
            throw new Error('The PlanetVectorTile plugin has not been loaded! Cannot load tile.');
        }
        if (!this.planet) {
            throw new Error('PlanetVectorTile source has not been loaded with a planet. Cannot load tile.');
        }

        const params = {
            uid: tile.uid,
            tileID: tile.tileID,
            zoom: tile.tileID.overscaledZ,
            tileSize: this.tileSize * tile.tileID.overscaleFactor(),
            type: this.type,
            source: this.id,
            pixelRatio: this.map.getPixelRatio(),
            showCollisionBoxes: this.map.showCollisionBoxes,
            pvtSources: this._options.tiles,
        };

        if (!tile.actor || tile.state === 'expired') {
            tile.actor = this.dispatcher.getActor();
            tile.request = tile.actor.send('loadTile', params, done.bind(this));
        } else if (tile.state === 'loading') {
            // schedule tile reloading after it has been loaded
            tile.reloadCallback = callback;
        } else {
            tile.request = tile.actor.send('reloadTile', params, done.bind(this));
        }

        function done(err, data) {
            delete tile.request;

            if (tile.aborted) return callback(null);

            if (err && err.status !== 404) {
                return callback(err);
            }

            // TODO Should we have expiry data?
            // Refresh tiles for real-time data use case?
            if (this.map._refreshExpiredTiles && data) tile.setExpiryData(data);
            tile.loadVectorData(data, this.map.painter);

            cacheEntryPossiblyAdded(this.dispatcher);

            callback(null);

            if (tile.reloadCallback) {
                this.loadTile(tile, tile.reloadCallback);
                tile.reloadCallback = null;
            }
        }
    }

    abortTile(tile: Tile) {
        if (tile.request) {
            tile.request.cancel();
            delete tile.request;
        }
        if (tile.actor) {
            tile.actor.send('abortTile', { uid: tile.uid, type: this.type, source: this.id }, undefined);
        }
    }

    unloadTile(tile: Tile) {
        tile.unloadVectorData();
        if (tile.actor) {
            tile.actor.send('removeTile', { uid: tile.uid, type: this.type, source: this.id }, undefined);
        }
    }

    hasTransition() {
        return false;
    }
}
