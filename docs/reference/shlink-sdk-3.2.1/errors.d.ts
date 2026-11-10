/**
 * Possible error types returned by Shlink's API
 */
export declare const ErrorType: {
    readonly INVALID_ARGUMENT: "https://shlink.io/api/error/invalid-data";
    readonly INVALID_SHORT_URL_DELETION: "https://shlink.io/api/error/invalid-short-url-deletion";
    readonly DOMAIN_NOT_FOUND: "https://shlink.io/api/error/domain-not-found";
    readonly FORBIDDEN_OPERATION: "https://shlink.io/api/error/forbidden-tag-operation";
    readonly INVALID_SLUG: "https://shlink.io/api/error/non-unique-slug";
    readonly INVALID_SHORTCODE: "https://shlink.io/api/error/short-url-not-found";
    readonly TAG_CONFLICT: "https://shlink.io/api/error/tag-conflict";
    readonly TAG_NOT_FOUND: "https://shlink.io/api/error/tag-not-found";
    readonly MERCURE_NOT_CONFIGURED: "https://shlink.io/api/error/mercure-not-configured";
    readonly INVALID_AUTHORIZATION: "https://shlink.io/api/error/missing-authentication";
    readonly INVALID_API_KEY: "https://shlink.io/api/error/invalid-api-key";
    readonly NOT_FOUND: "https://shlink.io/api/error/not-found";
    /** @deprecated Shlink 4.0.0 no longer validates URLs, so this error will never happen with that version */
    readonly INVALID_URL: "https://shlink.io/api/error/invalid-url";
};
/**
 * Shape of the errors returned by Shlink
 */
export type ProblemDetailsError = {
    type: string;
    detail: string;
    title: string;
    status: number;
    [extraProps: string]: any;
};
