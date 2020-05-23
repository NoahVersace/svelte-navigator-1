import {
  segmentize,
  join,
  addQuery,
  startsWith,
  paramRegex,
  isSplat,
  isRootSegment,
  isDynamic,
} from "./paths";
import { ROUTER_ID, fail } from "./warning";
import { isUndefined } from "./utils";

const SEGMENT_POINTS = 4;
const STATIC_POINTS = 3;
const DYNAMIC_POINTS = 2;
const SPLAT_PENALTY = 1;
const ROOT_POINTS = 1;

/**
 * Score a route depending on how its individual segments look
 * @param {object} route
 * @param {number} index
 * @return {object}
 */
export function rankRoute(route, index) {
  const score = route.default
    ? 0
    : segmentize(route.fullPath).reduce((acc, segment) => {
        let nextScore = acc;
        nextScore += SEGMENT_POINTS;

        if (isRootSegment(segment)) {
          nextScore += ROOT_POINTS;
        } else if (isDynamic(segment)) {
          nextScore += DYNAMIC_POINTS;
        } else if (isSplat(segment)) {
          nextScore -= SEGMENT_POINTS + SPLAT_PENALTY;
        } else {
          nextScore += STATIC_POINTS;
        }

        return nextScore;
      }, 0);

  return { route, score, index };
}

/**
 * Give a score to all routes and sort them on that
 * @param {object[]} routes
 * @return {object[]}
 */
export function rankRoutes(routes) {
  return (
    routes
      .map(rankRoute)
      // If two routes have the exact same score, we go by index instead
      .sort((a, b) => {
        if (a.score < b.score) {
          return 1;
        }
        if (a.score > b.score) {
          return -1;
        }
        return a.index - b.index;
      })
  );
}

/**
 * Ranks and picks the best route to match. Each segment gets the highest
 * amount of points, then the type of segment gets an additional amount of
 * points where
 *
 *  static > dynamic > splat > root
 *
 * This way we don't have to worry about the order of our routes, let the
 * computers do it.
 *
 * A route looks like this
 *
 *  { fullPath, default, value }
 *
 * And a returned match looks like:
 *
 *  { route, params, uri }
 *
 * @param {object[]} routes
 * @param {string} uri
 * @return {?object}
 */
export function pick(routes, uri) {
  let bestMatch;
  let defaultMatch;

  const [uriPathname] = uri.split("?");
  const uriSegments = segmentize(uriPathname);
  const isRootUri = uriSegments[0] === "";
  const ranked = rankRoutes(routes);

  for (let i = 0, l = ranked.length; i < l; i++) {
    const { route } = ranked[i];
    let missed = false;

    if (route.default) {
      defaultMatch = {
        route,
        params: {},
        uri,
      };
      continue;
    }

    const routeSegments = segmentize(route.fullPath);
    const params = {};
    const max = Math.max(uriSegments.length, routeSegments.length);
    let index = 0;

    for (; index < max; index++) {
      const routeSegment = routeSegments[index];
      const uriSegment = uriSegments[index];

      if (!isUndefined(routeSegment) && isSplat(routeSegment)) {
        // Hit a splat, just grab the rest, and return a match
        // uri:   /files/documents/work
        // route: /files/* or /files/*splatname
        const splatName = routeSegment === "*" ? "*" : routeSegment.slice(1);

        params[splatName] = uriSegments
          .slice(index)
          .map(decodeURIComponent)
          .join("/");
        break;
      }

      if (isUndefined(uriSegment)) {
        // URI is shorter than the route, no match
        // uri:   /users
        // route: /users/:userId
        missed = true;
        break;
      }

      const dynamicMatch = paramRegex.exec(routeSegment);

      if (dynamicMatch && !isRootUri) {
        const value = decodeURIComponent(uriSegment);
        params[dynamicMatch[1]] = value;
      } else if (routeSegment !== uriSegment) {
        // Current segments don't match, not dynamic, not splat, so no match
        // uri:   /users/123/settings
        // route: /users/:id/profile
        missed = true;
        break;
      }
    }

    if (!missed) {
      bestMatch = {
        route,
        params,
        uri: `/${uriSegments.slice(0, index).join("/")}`,
      };
      break;
    }
  }

  return bestMatch || defaultMatch || null;
}

/**
 * Check if the `route.fullPath` matches the `uri`.
 * @param {Object} route
 * @param {string} uri
 * @return {?object}
 */
export function match(route, uri) {
  return pick([route], uri);
}

/**
 * Resolve URIs as though every path is a directory, no files. Relative URIs
 * in the browser can feel awkward because not only can you be "in a directory",
 * you can be "at a file", too. For example:
 *
 *  browserSpecResolve('foo', '/bar/') => /bar/foo
 *  browserSpecResolve('foo', '/bar') => /foo
 *
 * But on the command line of a file system, it's not as complicated. You can't
 * `cd` from a file, only directories. This way, links have to know less about
 * their current path. To go deeper you can do this:
 *
 *  <Link to="deeper"/>
 *  // instead of
 *  <Link to=`{${props.uri}/deeper}`/>
 *
 * Just like `cd`, if you want to go deeper from the command line, you do this:
 *
 *  cd deeper
 *  # not
 *  cd $(pwd)/deeper
 *
 * By treating every path as a directory, linking to relative paths should
 * require less contextual information and (fingers crossed) be more intuitive.
 * @param {string} to
 * @param {string} base
 * @return {string}
 */
export function resolve(to, base) {
  // /foo/bar, /baz/qux => /foo/bar
  if (startsWith(to, "/")) {
    return to;
  }

  const [toPathname, toQuery] = to.split("?");
  const [basePathname] = base.split("?");
  const toSegments = segmentize(toPathname);
  const baseSegments = segmentize(basePathname);

  // ?a=b, /users?b=c => /users?a=b
  if (toSegments[0] === "") {
    return addQuery(basePathname, toQuery);
  }

  // profile, /users/789 => /users/789/profile
  if (!startsWith(toSegments[0], ".")) {
    const pathname = baseSegments.concat(toSegments).join("/");
    return addQuery((basePathname === "/" ? "" : "/") + pathname, toQuery);
  }

  // ./       , /users/123 => /users/123
  // ../      , /users/123 => /users
  // ../..    , /users/123 => /
  // ../../one, /a/b/c/d   => /a/b/one
  // .././one , /a/b/c/d   => /a/b/c/one
  const allSegments = baseSegments.concat(toSegments);
  const segments = [];

  allSegments.forEach(segment => {
    if (segment === "..") {
      segments.pop();
    } else if (segment !== ".") {
      segments.push(segment);
    }
  });

  return addQuery(`/${segments.join("/")}`, toQuery);
}

/**
 * Normalizes a location for consumption by `Route` children and the `Router`.
 * It removes the apps basepath from the pathnam
 * and sets default values for `search` and `hash` properties.
 *
 * @param {Object} location The current global location supplied by the history component
 * @param {string} basepath The applications basepath (i.e. when serving from a subdirectory)
 *
 * @returns The normalized location
 */
export function normalizeLocation(location, basepath) {
  const { pathname, hash = "", search = "", state } = location;
  const baseSegments = segmentize(basepath).filter(Boolean);
  const pathSegments = segmentize(pathname).filter(Boolean);
  while (baseSegments.length) {
    if (baseSegments[0] !== pathSegments[0]) {
      fail(
        ROUTER_ID,
        `Invalid state: All locations must begin with the basepath "${basepath}", found "${pathname}"`,
      );
    }
    baseSegments.shift();
    pathSegments.shift();
  }
  return {
    pathname: join(...pathSegments),
    hash,
    search,
    state,
  };
}

/**
 * Resolves a link relative to the parent Route and the Routers basepath.
 *
 * @param {string} path The given path, that will be resolved
 * @param {string} routeBase The current Routes base path
 * @param {string} appBase The basepath of the app. Used, when serving from a subdirectory
 * @returns {string} The resolved path
 *
 * @example
 * resolveLink("relative", "/routeBase", "/") // -> "/routeBase/relative"
 * resolveLink("/absolute", "/routeBase", "/") // -> "/absolute"
 * resolveLink("relative", "/routeBase", "/base") // -> "/base/routeBase/relative"
 * resolveLink("/absolute", "/routeBase", "/base") // -> "/base/absolute"
 */
export function resolveLink(path, routeBase, appBase) {
  return join(appBase, resolve(path, routeBase));
}
