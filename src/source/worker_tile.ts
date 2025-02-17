import FeatureIndex from '../data/feature_index';

import {performSymbolLayout} from '../symbol/symbol_layout';
import {CollisionBoxArray} from '../data/array_types.g';
import DictionaryCoder from '../util/dictionary_coder';
import SymbolBucket from '../data/bucket/symbol_bucket';
import LineBucket from '../data/bucket/line_bucket';
import FillBucket from '../data/bucket/fill_bucket';
import FillExtrusionBucket from '../data/bucket/fill_extrusion_bucket';
import {warnOnce, mapObject} from '../util/util';
import ImageAtlas from '../render/image_atlas';
import GlyphAtlas from '../render/glyph_atlas';
import EvaluationParameters from '../style/evaluation_parameters';
import {OverscaledTileID} from './tile_id';

import type {Bucket} from '../data/bucket';
import type Actor from '../util/actor';
import type StyleLayer from '../style/style_layer';
import type StyleLayerIndex from '../style/style_layer_index';
import type {StyleImage} from '../style/style_image';
import type {StyleGlyph} from '../style/style_glyph';
import type {
    WorkerTileParameters,
    WorkerTileCallback,
} from '../source/worker_source';
import type {PromoteIdSpecification} from '../style-spec/types.g';
import type {VectorTile} from '@mapbox/vector-tile';
import { PVT } from '../../../dist/pvt';

class WorkerTile {
    tileID: OverscaledTileID;
    uid: string;
    zoom: number;
    pixelRatio: number;
    tileSize: number;
    source: string;
    promoteId: PromoteIdSpecification;
    overscaling: number;
    showCollisionBoxes: boolean;
    collectResourceTiming: boolean;
    returnDependencies: boolean;

    status: 'parsing' | 'done';
    data: VectorTile;
    collisionBoxArray: CollisionBoxArray;

    abort: (() => void);
    aborted: boolean;
    reloadCallback: WorkerTileCallback;
    vectorTile: VectorTile;

    constructor(params: WorkerTileParameters) {
        this.tileID = new OverscaledTileID(params.tileID.overscaledZ, params.tileID.wrap, params.tileID.canonical.z, params.tileID.canonical.x, params.tileID.canonical.y);
        this.uid = params.uid;
        this.zoom = params.zoom;
        this.pixelRatio = params.pixelRatio;
        this.tileSize = params.tileSize;
        this.source = params.source;
        this.overscaling = this.tileID.overscaleFactor();
        this.showCollisionBoxes = params.showCollisionBoxes;
        this.collectResourceTiming = !!params.collectResourceTiming;
        this.returnDependencies = !!params.returnDependencies;
        this.promoteId = params.promoteId;
    }

    parse(data: VectorTile, layerIndex: StyleLayerIndex, availableImages: Array<string>, actor: Actor, callback: WorkerTileCallback) {
        this.status = 'parsing';
        // This is an unnecessary refererence to PVT, and it keeps the object retained in memory when it is not needed.
        // Leaving this for MVT for posterity, though I see no references accessing the data property.
        if (data instanceof PVT === false) {
            this.data = data;
        }

        this.collisionBoxArray = new CollisionBoxArray();
        const sourceLayerCoder = new DictionaryCoder(Object.keys(data.layers).sort());

        const featureIndex = new FeatureIndex(this.tileID, this.promoteId);
        featureIndex.bucketLayerIDs = [];

        // Including the JavaScript PVT object is used so we do not have to 
        // hold onto the data buffer and reparse it in the main thread.
        if (data instanceof PVT) {
            featureIndex.vtLayers = data.layers;
        }

        // This is helpful for all layer types to track what layers are in the tiles.
        featureIndex.layerIds = Object.keys(data.layers);

        const buckets: {[_: string]: Bucket} = {};

        const options = {
            featureIndex,
            iconDependencies: {},
            patternDependencies: {},
            glyphDependencies: {},
            availableImages
        };

        const layerFamilies = layerIndex.familiesBySource[this.source];
        for (const sourceLayerId in layerFamilies) {
            const sourceLayer = data.layers[sourceLayerId];
            if (!sourceLayer) {
                continue;
            }

            if (sourceLayer.version === 1) {
                warnOnce(`Vector tile source "${this.source}" layer "${sourceLayerId}" ` +
                    'does not use vector tile spec v2 and therefore may have some rendering errors.');
            }

            const sourceLayerIndex = sourceLayerCoder.encode(sourceLayerId);
            const features = [];
            for (let index = 0; index < sourceLayer.length; index++) {
                const feature = sourceLayer.feature(index);
                const id = featureIndex.getId(feature, sourceLayerId);
                features.push({feature, id, index, sourceLayerIndex});
            }

            for (const family of layerFamilies[sourceLayerId]) {
                const layer = family[0];

                if (layer.source !== this.source) {
                    warnOnce(`layer.source = ${layer.source} does not equal this.source = ${this.source}`);
                }
                if (layer.minzoom && this.zoom < Math.floor(layer.minzoom)) continue;
                if (layer.maxzoom && this.zoom >= layer.maxzoom) continue;
                if (layer.visibility === 'none') continue;

                recalculateLayers(family, this.zoom, availableImages);

                const bucket = buckets[layer.id] = layer.createBucket({
                    index: featureIndex.bucketLayerIDs.length,
                    layers: family,
                    zoom: this.zoom,
                    pixelRatio: this.pixelRatio,
                    overscaling: this.overscaling,
                    collisionBoxArray: this.collisionBoxArray,
                    sourceLayerIndex,
                    sourceID: this.source
                });

                bucket.populate(features, options, this.tileID.canonical);
                featureIndex.bucketLayerIDs.push(family.map((l) => l.id));
            }
        }

        let error: Error;
        let glyphMap: {
            [_: string]: {
                [_: number]: StyleGlyph;
            };
        };
        let iconMap: {[_: string]: StyleImage};
        let patternMap: {[_: string]: StyleImage};

        const stacks = mapObject(options.glyphDependencies, (glyphs) => Object.keys(glyphs).map(Number));
        if (Object.keys(stacks).length) {
            actor.send('getGlyphs', {uid: this.uid, stacks}, (err, result) => {
                if (!error) {
                    error = err;
                    glyphMap = result;
                    maybePrepare.call(this);
                }
            });
        } else {
            glyphMap = {};
        }

        const icons = Object.keys(options.iconDependencies);
        if (icons.length) {
            actor.send('getImages', {icons, source: this.source, tileID: this.tileID, type: 'icons'}, (err, result) => {
                if (!error) {
                    error = err;
                    iconMap = result;
                    maybePrepare.call(this);
                }
            });
        } else {
            iconMap = {};
        }

        const patterns = Object.keys(options.patternDependencies);
        if (patterns.length) {
            actor.send('getImages', {icons: patterns, source: this.source, tileID: this.tileID, type: 'patterns'}, (err, result) => {
                if (!error) {
                    error = err;
                    patternMap = result;
                    maybePrepare.call(this);
                }
            });
        } else {
            patternMap = {};
        }

        maybePrepare.call(this);

        function maybePrepare() {
            if (error) {
                return callback(error);
            } else if (glyphMap && iconMap && patternMap) {
                const glyphAtlas = new GlyphAtlas(glyphMap);
                const imageAtlas = new ImageAtlas(iconMap, patternMap);

                for (const key in buckets) {
                    const bucket = buckets[key];
                    if (bucket instanceof SymbolBucket) {
                        recalculateLayers(bucket.layers, this.zoom, availableImages);
                        performSymbolLayout({
                            bucket,
                            glyphMap,
                            glyphPositions: glyphAtlas.positions,
                            imageMap: iconMap,
                            imagePositions: imageAtlas.iconPositions,
                            showCollisionBoxes: this.showCollisionBoxes,
                            canonical: this.tileID.canonical
                        });
                    } else if (bucket.hasPattern &&
                        (bucket instanceof LineBucket ||
                         bucket instanceof FillBucket ||
                         bucket instanceof FillExtrusionBucket)) {
                        recalculateLayers(bucket.layers, this.zoom, availableImages);
                        bucket.addFeatures(options, this.tileID.canonical, imageAtlas.patternPositions);
                    }
                }

                this.status = 'done';
                callback(null, {
                    buckets: Object.values(buckets).filter(b => !b.isEmpty()),
                    featureIndex,
                    collisionBoxArray: this.collisionBoxArray,
                    glyphAtlasImage: glyphAtlas.image,
                    imageAtlas,
                    // Only used for benchmarking:
                    glyphMap: this.returnDependencies ? glyphMap : null,
                    iconMap: this.returnDependencies ? iconMap : null,
                    glyphPositions: this.returnDependencies ? glyphAtlas.positions : null
                });
            }
        }
    }
}

function recalculateLayers(layers: ReadonlyArray<StyleLayer>, zoom: number, availableImages: Array<string>) {
    // Layers are shared and may have been used by a WorkerTile with a different zoom.
    const parameters = new EvaluationParameters(zoom);
    for (const layer of layers) {
        layer.recalculate(parameters, availableImages);
    }
}

export default WorkerTile;
