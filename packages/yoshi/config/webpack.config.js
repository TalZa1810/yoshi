const path = require('path');
const fs = require('fs');
const webpack = require('webpack');
const { isObject } = require('lodash');
const nodeExternals = require('webpack-node-externals');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
const CaseSensitivePathsPlugin = require('case-sensitive-paths-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const UglifyJsPlugin = require('uglifyjs-webpack-plugin');
const StylableWebpackPlugin = require('@stylable/webpack-plugin');
const TpaStyleWebpackPlugin = require('tpa-style-webpack-plugin');
const RtlCssPlugin = require('rtlcss-webpack-plugin');
const xmldoc = require('xmldoc');
const ModuleNotFoundPlugin = require('react-dev-utils/ModuleNotFoundPlugin');
const DynamicPublicPath = require('../src/webpack-plugins/dynamic-public-path');
const { localIdentName, staticsDomain } = require('../src/constants');
const {
  ROOT_DIR,
  SRC_DIR,
  BUILD_DIR,
  STATICS_DIR,
  POM_FILE,
  TSCONFIG_FILE,
} = require('yoshi-config/paths');
const project = require('yoshi-config');
const {
  toIdentifier,
  isSingleEntry,
  isProduction: checkIsProduction,
  inTeamCity: checkInTeamCity,
  isTypescriptProject: checkIsTypescriptProject,
} = require('yoshi-helpers');

const reScript = /\.js?$/;
const reStyle = /\.(css|less|scss|sass)$/;
const reAssets = /\.(png|jpg|jpeg|gif|svg|woff|woff2|ttf|otf|eot|wav|mp3)$/;

const disableTsThreadOptimization =
  process.env.DISABLE_TS_THREAD_OPTIMIZATION === 'true';

const disableModuleConcat = process.env.DISABLE_MODULE_CONCATENATION === 'true';

const isProduction = checkIsProduction();

const inTeamCity = checkInTeamCity();

const isTypescriptProject = checkIsTypescriptProject();

const isDevelopment = process.env.NODE_ENV === 'development';

const computedSeparateCss =
  project.separateCss === 'prod'
    ? inTeamCity || isProduction
    : project.separateCss;

const artifactVersion = process.env.ARTIFACT_VERSION;

// default public path
let publicPath = '/';

if (isDevelopment) {
  // Set the local dev-server url as a path
  publicPath = project.servers.cdn.url;
}

// In case we are running in CI and there is a pom.xml file, change the public path according to the path on the cdn
// The path is created using artifactName from pom.xml and artifact version from an environment param.
if (inTeamCity && artifactVersion && fs.existsSync(POM_FILE)) {
  const artifactName = new xmldoc.XmlDocument(
    fs.readFileSync(POM_FILE),
  ).valueWithPath('artifactId');

  publicPath = `${staticsDomain}/${artifactName}/${artifactVersion.replace(
    '-SNAPSHOT',
    '',
  )}/`;
}

// NOTE ABOUT PUBLIC PATH USING UNPKG SERVICE
// Projects that uses `wnpm-ci` have their package.json version field on a fixed version which is not their real version
// These projects determine their version on the "release" step, which means they will have a wrong public path
// We currently can't support static public path of packages that deploy to unpkg

const stylableSeparateCss = project.enhancedTpaStyle;

const defaultSplitChunksConfig = {
  chunks: 'all',
  name: 'commons',
  minChunks: 2,
};

const useSplitChunks = project.splitChunks;

const splitChunksConfig = isObject(useSplitChunks)
  ? useSplitChunks
  : defaultSplitChunksConfig;

const entry = project.entry || project.defaultEntry;

function overrideRules(rules, patch) {
  return rules.map(ruleToPatch => {
    let rule = patch(ruleToPatch);
    if (rule.rules) {
      rule = { ...rule, rules: overrideRules(rule.rules, patch) };
    }
    if (rule.oneOf) {
      rule = { ...rule, oneOf: overrideRules(rule.oneOf, patch) };
    }
    return rule;
  });
}

// Common function to get style loaders
const getStyleLoaders = ({
  embedCss,
  isDebug,

  // Allow overriding defaults
  separateCss = computedSeparateCss,
  hmr = project.hmr,
  tpaStyle = project.tpaStyle,
}) => {
  const cssLoaderOptions = {
    camelCase: true,
    sourceMap: !!separateCss,
    localIdentName: isDebug ? localIdentName.long : localIdentName.short,
    // Make sure every package has unique class names
    hashPrefix: project.name,
    // https://github.com/css-modules/css-modules
    modules: project.cssModules,
    // PostCSS, less-loader, sass-loader and resolve-url-loader, so
    // composition will work with import
    importLoaders: 4 + Number(tpaStyle),
  };

  return [
    {
      test: reStyle,
      exclude: /\.st\.css$/,
      rules: [
        ...(embedCss
          ? [
              // https://github.com/shepherdwind/css-hot-loader
              ...(hmr ? [{ loader: 'css-hot-loader' }] : []),

              // Process every style asset with either `style-loader`
              // or `mini-css-extract-plugin`
              ...(separateCss
                ? [
                    {
                      loader: MiniCssExtractPlugin.loader,
                      options: {
                        // By default it use publicPath in webpackOptions.output
                        // We are overriding it to restore relative paths in url() calls
                        publicPath: '',
                      },
                    },
                  ]
                : [
                    {
                      loader: 'style-loader',
                      options: {
                        // Reuses a single `<style></style>` element
                        singleton: true,
                      },
                    },
                  ]),

              {
                oneOf: [
                  // Files ending with `.global.(css|sass|scss|less)` will be transpiled with
                  // `modules: false`
                  {
                    test: /\.global\.[A-z]*$/,
                    loader: 'css-loader',
                    options: {
                      ...cssLoaderOptions,
                      modules: false,
                    },
                  },
                  {
                    // https://github.com/webpack/css-loader
                    loader: 'css-loader',
                    options: cssLoaderOptions,
                  },
                ],
              },
              {
                loader: 'postcss-loader',
                options: {
                  // https://github.com/facebookincubator/create-react-app/issues/2677
                  ident: 'postcss',
                  plugins: [require('autoprefixer')],
                  sourceMap: isDebug,
                },
              },

              // https://github.com/bholloway/resolve-url-loader
              {
                loader: 'resolve-url-loader',
                options: { attempts: 1 },
              },
            ]
          : [
              {
                loader: 'css-loader/locals',
                options: {
                  ...cssLoaderOptions,
                  importLoaders: 2 + Number(tpaStyle),
                  sourceMap: false,
                },
              },
            ]),

        // https://github.com/wix/wix-tpa-style-loader
        ...(tpaStyle ? [{ loader: 'wix-tpa-style-loader' }] : []),

        // https://github.com/webpack-contrib/less-loader
        {
          test: /\.less$/,
          loader: 'less-loader',
          options: {
            sourceMap: embedCss,
            paths: ['.', 'node_modules'],
          },
        },

        // https://github.com/webpack-contrib/sass-loader
        {
          test: /\.(scss|sass)$/,
          loader: 'sass-loader',
          options: {
            sourceMap: embedCss,
            includePaths: ['node_modules', 'node_modules/compass-mixins/lib'],
          },
        },
      ],
    },
  ];
};

// Wrapper that returns array of configs for each bundle configuration.
function wrapConfigForMultiBundles(config) {
  return function({ bundleConfigs, ...configParams } = {}) {
    if (bundleConfigs) {
      return bundleConfigs.map(bundleConfig =>
        config({ ...configParams, bundleConfig }),
      );
    }
    return config(configParams);
  };
}

//
// Common configuration chunk to be used for both
// client-side (client.js) and server-side (server.js) bundles
// -----------------------------------------------------------------------------
function createCommonWebpackConfig({
  isDebug = true,
  bundleConfig = {},
  withLocalSourceMaps,
} = {}) {
  const { id: bundleId, targets: bundleTargets } = bundleConfig;
  const formattedBundleName = bundleId ? `${bundleId}.` : '';

  const config = {
    context: SRC_DIR,

    mode: isProduction ? 'production' : 'development',

    output: {
      path: STATICS_DIR,
      publicPath,
      pathinfo: isDebug,
      filename: isDebug
        ? '[name].bundle.js'
        : `[name].${formattedBundleName}bundle.min.js`,
      chunkFilename: isDebug
        ? '[name].chunk.js'
        : `[name].${formattedBundleName}chunk.min.js`,
    },

    resolve: {
      modules: ['node_modules', SRC_DIR],

      extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],

      alias: project.resolveAlias,

      // Whether to resolve symlinks to their symlinked location.
      symlinks: false,
    },

    // Since Yoshi doesn't depend on every loader it uses directly, we first look
    // for loaders in Yoshi's `node_modules` and then look at the root `node_modules`
    //
    // See https://github.com/wix/yoshi/pull/392
    resolveLoader: {
      modules: [path.join(__dirname, '../node_modules'), 'node_modules'],
    },

    plugins: [
      // This gives some necessary context to module not found errors, such as
      // the requesting resource
      new ModuleNotFoundPlugin(ROOT_DIR),
      // https://github.com/Urthen/case-sensitive-paths-webpack-plugin
      new CaseSensitivePathsPlugin(),
      // https://github.com/Realytics/fork-ts-checker-webpack-plugin
      ...(isTypescriptProject && project.experimentalServerBundle
        ? [
            // Since `fork-ts-checker-webpack-plugin` requires you to have
            // TypeScript installed when its required, we only require it if
            // this is a TypeScript project
            new (require('fork-ts-checker-webpack-plugin'))({
              tsconfig: TSCONFIG_FILE,
              async: false,
            }),
          ]
        : []),
      // Way of communicating to `babel-preset-yoshi` or `babel-preset-wix` that
      // it should optimize for Webpack
      { apply: () => (process.env.IN_WEBPACK = 'true') },
    ],

    module: {
      rules: [
        // https://github.com/wix/externalize-relative-module-loader
        ...(project.features.externalizeRelativeLodash
          ? [
              {
                test: /[\\/]node_modules[\\/]lodash/,
                loader: 'externalize-relative-module-loader',
              },
            ]
          : []),

        // https://github.com/huston007/ng-annotate-loader
        ...(project.isAngularProject
          ? [
              {
                test: reScript,
                loader: 'ng-annotate-loader',
                include: project.unprocessedModules,
              },
            ]
          : []),

        // Rules for TS / TSX
        {
          test: /\.(ts|tsx)$/,
          exclude: /(node_modules)/,
          use: [
            ...(disableTsThreadOptimization
              ? []
              : [
                  {
                    loader: 'thread-loader',
                    options: {
                      workers: require('os').cpus().length - 1,
                    },
                  },
                ]),

            // https://github.com/huston007/ng-annotate-loader
            ...(project.isAngularProject
              ? [{ loader: 'ng-annotate-loader' }]
              : []),

            {
              loader: 'ts-loader',
              options: {
                // This implicitly sets `transpileOnly` to `true`
                happyPackMode: !disableTsThreadOptimization,
                compilerOptions: project.isAngularProject
                  ? {}
                  : {
                      // force es modules for tree shaking
                      module: 'esnext',
                      // use same module resolution
                      moduleResolution: 'node',
                      // optimize target to latest chrome for local development
                      ...(isDevelopment
                        ? {
                            // allow using Promises, Array.prototype.includes, String.prototype.padStart, etc.
                            lib: ['es2017'],
                            // use async/await instead of embedding polyfills
                            target: 'es2017',
                          }
                        : {}),
                    },
              },
            },
          ],
        },

        // Rules for JS
        {
          test: reScript,
          include: project.unprocessedModules,
          use: [
            {
              loader: 'thread-loader',
              options: {
                workers: require('os').cpus().length - 1,
              },
            },
            {
              loader: 'babel-loader',
              options: bundleTargets
                ? {
                    presets: [
                      [
                        'yoshi',
                        {
                          // Update to { targets: bundleTargets } after babel 7 PR merge (https://github.com/babel/babel/pull/8509)
                          targets: {
                            browsers: bundleTargets,
                          },
                        },
                      ],
                    ],
                  }
                : undefined,
            },
          ],
        },

        // Rules for assets
        {
          oneOf: [
            // Inline SVG images into CSS
            {
              test: /\.inline\.svg$/,
              loader: 'svg-inline-loader',
            },

            // Try to inline assets as base64 or return a public URL to it if it passes
            // the 10kb limit
            {
              test: reAssets,
              loader: 'url-loader',
              options: {
                name: '[path][name].[ext]?[hash]',
                limit: 10000,
              },
            },
          ],
        },

        // Rules for Markdown
        {
          test: /\.md$/,
          loader: 'raw-loader',
        },

        // Rules for HAML
        {
          test: /\.haml$/,
          loader: 'ruby-haml-loader',
        },

        // Rules for HTML
        {
          test: /\.html$/,
          loader: 'html-loader',
        },

        // Rules for GraphQL
        {
          test: /\.(graphql|gql)$/,
          include: project.unprocessedModules,
          loader: 'graphql-tag/loader',
        },
      ],
    },

    // https://webpack.js.org/configuration/stats/
    stats: 'none',

    // https://github.com/webpack/node-libs-browser/tree/master/mock
    node: {
      fs: 'empty',
      net: 'empty',
      tls: 'empty',
      __dirname: true,
    },

    // https://webpack.js.org/configuration/devtool
    // If we are in CI or requested explictly we create full source maps
    // Once we are in a local build, we create cheap eval source map only
    // for a development build (hence the !isProduction)
    devtool:
      inTeamCity || withLocalSourceMaps
        ? 'source-map'
        : !isProduction
          ? 'cheap-module-eval-source-map'
          : false,
  };

  return config;
}

//
// Configuration for the client-side bundle (client.js)
// -----------------------------------------------------------------------------
function createClientWebpackConfig({
  isAnalyze = false,
  isDebug = true,
  bundleConfig,
  withLocalSourceMaps,
} = {}) {
  const config = createCommonWebpackConfig({
    isDebug,
    withLocalSourceMaps,
    bundleConfig,
  });

  const styleLoaders = getStyleLoaders({ embedCss: true, isDebug });

  const clientConfig = {
    ...config,

    name: 'client',

    target: 'web',

    entry: isSingleEntry(entry) ? { app: entry } : entry,

    optimization: {
      minimize: !isDebug,
      splitChunks: useSplitChunks ? splitChunksConfig : false,
      concatenateModules: isProduction && !disableModuleConcat,
      minimizer: [
        new UglifyJsPlugin({
          // Use multi-process parallel running to improve the build speed
          // Default number of concurrent runs: os.cpus().length - 1
          parallel: true,
          // Enable file caching
          cache: true,
          sourceMap: true,
          uglifyOptions: {
            output: {
              // support emojis
              ascii_only: true,
            },
            keep_fnames: project.keepFunctionNames,
          },
        }),
      ],
    },

    output: {
      ...config.output,

      // https://github.com/wix/yoshi/pull/497
      jsonpFunction: `webpackJsonp_${toIdentifier(project.name)}`,

      // Bundle as UMD format if the user configured that this is a library
      ...(project.exports
        ? {
            library: project.exports,
            libraryTarget: 'umd',
            globalObject: "(typeof self !== 'undefined' ? self : this)",
          }
        : {}),

      // https://webpack.js.org/configuration/output/#output-umdnameddefine
      umdNamedDefine: project.umdNamedDefine,
    },

    plugins: [
      ...config.plugins,

      // https://webpack.js.org/plugins/loader-options-plugin
      new webpack.LoaderOptionsPlugin({
        minimize: !isDebug,
      }),

      ...(computedSeparateCss
        ? [
            // https://github.com/webpack-contrib/mini-css-extract-plugin
            new MiniCssExtractPlugin({
              filename: isDebug ? '[name].css' : '[name].min.css',
            }),
            // https://github.com/wix-incubator/tpa-style-webpack-plugin
            ...(project.enhancedTpaStyle ? [new TpaStyleWebpackPlugin()] : []),
            // https://github.com/wix/rtlcss-webpack-plugin
            new RtlCssPlugin(isDebug ? '[name].rtl.css' : '[name].rtl.min.css'),
          ]
        : []),

      // Hacky way of correcting Webpack's publicPath
      new DynamicPublicPath(),

      // https://webpack.js.org/plugins/define-plugin/
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify(
          isProduction ? 'production' : 'development',
        ),
        'window.__CI_APP_VERSION__': JSON.stringify(
          artifactVersion ? artifactVersion : '0.0.0',
        ),
      }),

      // https://github.com/jmblog/how-to-optimize-momentjs-with-webpack
      new webpack.IgnorePlugin(/^\.\/locale$/, /moment$/),

      // https://github.com/wix/stylable
      new StylableWebpackPlugin({
        outputCSS: stylableSeparateCss,
        filename: '[name].stylable.bundle.css',
        includeCSSInJS: !stylableSeparateCss,
        optimize: { classNameOptimizations: false, shortNamespaces: false },
      }),

      // https://github.com/th0r/webpack-bundle-analyzer
      ...(isAnalyze ? [new BundleAnalyzerPlugin()] : []),
    ],

    module: {
      ...config.module,

      rules: [
        ...config.module.rules,

        // Rules for Style Sheets
        ...styleLoaders,
      ],
    },

    externals: project.externals,

    // https://webpack.js.org/configuration/performance
    performance: {
      ...(isProduction
        ? project.performanceBudget || { hints: false }
        : {
            hints: false,
          }),
    },
  };

  return clientConfig;
}

//
// Configuration for the server-side bundle (server.js)
// -----------------------------------------------------------------------------
function createServerWebpackConfig({ isDebug = true } = {}) {
  const config = createCommonWebpackConfig({ isDebug });

  const styleLoaders = getStyleLoaders({ embedCss: false, isDebug });

  const serverConfig = {
    ...config,

    name: 'server',

    target: 'node',

    entry: {
      server: './server',
    },

    output: {
      ...config.output,
      path: BUILD_DIR,
      filename: '[name].js',
      chunkFilename: 'chunks/[name].js',
      libraryTarget: 'umd',
      libraryExport: 'default',
      globalObject: "(typeof self !== 'undefined' ? self : this)",
      hotUpdateMainFilename: 'updates/[hash].hot-update.json',
      hotUpdateChunkFilename: 'updates/[id].[hash].hot-update.js',
      // Point sourcemap entries to original disk location (format as URL on Windows)
      devtoolModuleFilenameTemplate: info =>
        path.resolve(info.absoluteResourcePath).replace(/\\/g, '/'),
    },

    // Webpack mutates resolve object, so clone it to avoid issues
    // https://github.com/webpack/webpack/issues/4817
    resolve: {
      ...config.resolve,
    },

    module: {
      ...config.module,

      rules: [
        ...overrideRules(config.module.rules, rule => {
          // Override paths to static assets
          if (rule.loader === 'file-loader' || rule.loader === 'url-loader') {
            return {
              ...rule,
              options: {
                ...rule.options,
                emitFile: false,
              },
            };
          }

          return rule;
        }),

        // Rules for Style Sheets
        ...styleLoaders,
      ],
    },

    externals: [
      nodeExternals({
        whitelist: [reStyle, reAssets, /bootstrap-hot-loader/],
      }),
    ],

    plugins: [
      ...config.plugins,

      // https://webpack.js.org/plugins/banner-plugin/
      new webpack.BannerPlugin({
        // https://github.com/evanw/node-source-map-support
        banner: 'require("source-map-support").install();',
        raw: true,
        entryOnly: false,
      }),
    ],

    // https://webpack.js.org/configuration/optimization
    optimization: {
      // Do not modify/set the value of `process.env.NODE_ENV`
      nodeEnv: false,
    },

    // Do not replace node globals with polyfills
    // https://webpack.js.org/configuration/node/
    node: {
      console: false,
      global: false,
      process: false,
      Buffer: false,
      __filename: false,
      __dirname: false,
    },

    devtool: 'cheap-module-inline-source-map',
  };

  return serverConfig;
}

module.exports = {
  createCommonWebpackConfig,
  createClientWebpackConfig,
  createServerWebpackConfig,
  wrapConfigForMultiBundles,
  getStyleLoaders,
};
