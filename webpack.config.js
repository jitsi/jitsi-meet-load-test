/* global __dirname */

const process = require('process');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
const analyzeBundle = process.argv.indexOf('--analyze-bundle') !== -1;
const minimize
    = process.argv.indexOf('-p') !== -1
        || process.argv.indexOf('--optimize-minimize') !== -1;

/**
 * Build a Performance configuration object for the given size.
 * See: https://webpack.js.org/configuration/performance/
 */
function getPerformanceHints(size) {
    return {
        hints: minimize ? 'error' : false,
        maxAssetSize: size,
        maxEntrypointSize: size
    };
}

// The base Webpack configuration to bundle the JavaScript artifacts of
// jitsi-meet such as app.bundle.js and external_api.js.
const config = {
    devtool: 'source-map',
    mode: minimize ? 'production' : 'development',
    module: {
        rules: [ {
            loader: 'babel-loader',
            options: {
                // XXX The require.resolve bellow solves failures to locate the
                // presets when lib-jitsi-meet, for example, is npm linked in
                // jitsi-meet.
                plugins: [
                    require.resolve('@babel/plugin-transform-flow-strip-types'),
                    require.resolve('@babel/plugin-proposal-class-properties'),
                    require.resolve('@babel/plugin-proposal-export-default-from'),
                    require.resolve('@babel/plugin-proposal-export-namespace-from'),
                    require.resolve('@babel/plugin-proposal-nullish-coalescing-operator'),
                    require.resolve('@babel/plugin-proposal-optional-chaining')
                ],
                presets: [
                    [
                        require.resolve('@babel/preset-env'),

                        // Tell babel to avoid compiling imports into CommonJS
                        // so that webpack may do tree shaking.
                        {
                            modules: false,

                            // Specify our target browsers so no transpiling is
                            // done unnecessarily. For browsers not specified
                            // here, the ES2015+ profile will be used.
                            targets: {
                                chrome: 58,
                                electron: 2,
                                firefox: 54,
                                safari: 11
                            }

                        }
                    ],
                    require.resolve('@babel/preset-flow'),
                ]
            },
            test: /\.jsx?$/
        }, {
            // Expose jquery as the globals $ and jQuery because it is expected
            // to be available in such a form by multiple jitsi-meet
            // dependencies including lib-jitsi-meet.

            loader: 'expose-loader?$!expose-loader?jQuery',
            test: /\/node_modules\/jquery\/.*\.js$/
        } ]
    },
    node: {
        // Allow the use of the real filename of the module being executed. By
        // default Webpack does not leak path-related information and provides a
        // value that is a mock (/index.js).
        __filename: true
    },
    optimization: {
        concatenateModules: minimize,
        minimize
    },
    output: {
        filename: `[name]${minimize ? '.min' : ''}.js`,
        path: `${__dirname}/libs`,
        sourceMapFilename: `[name].${minimize ? 'min' : 'js'}.map`
    },
    plugins: [
        analyzeBundle
            && new BundleAnalyzerPlugin({
                analyzerMode: 'disabled',
                generateStatsFile: true
            })
    ].filter(Boolean),
    resolve: {
        alias: {
            jquery: `jquery/dist/jquery${minimize ? '.min' : ''}.js`
        },
        aliasFields: [
            'browser'
        ]
    }
};

module.exports = [
    Object.assign({}, config, {
        entry: {
            'load-test-participant': './src/index.js'
        },
        performance: getPerformanceHints(3 * 1024 * 1024)
    })
];
