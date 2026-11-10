import { Abortable, ShlinkApiClient as BaseShlinkApiClient, ShlinkCreateShortUrlData, ShlinkDeleteVisitsResult, ShlinkDomainRedirects, ShlinkDomainsList, ShlinkEditDomainRedirects, ShlinkEditShortUrlData, ShlinkHealth, ShlinkMercureInfo, ShlinkOrphanVisitsParams, ShlinkRedirectRulesList, ShlinkRenaming, ShlinkSetRedirectRulesData, ShlinkShortUrl, ShlinkShortUrlIdentifier, ShlinkShortUrlsList, ShlinkShortUrlsListParams, ShlinkTagsList, ShlinkTagsStatsList, ShlinkVisitsList, ShlinkVisitsOverview, ShlinkVisitsParams, ShlinkWithDomainVisitsParams } from '../api-contract';
import { HttpClient, RequestCredentials } from './HttpClient';
export type ServerInfo = {
    baseUrl: string;
    apiKey: string;
};
export type ShlinkApiClientOptions = {
    requestCredentials?: RequestCredentials;
};
export declare class ShlinkApiClient implements BaseShlinkApiClient {
    #private;
    constructor(httpClient: HttpClient, serverInfo: ServerInfo, clientOptions?: ShlinkApiClientOptions);
    listShortUrls({ signal, ...params }?: ShlinkShortUrlsListParams & Abortable): Promise<ShlinkShortUrlsList>;
    createShortUrl({ signal, ...data }: ShlinkCreateShortUrlData & Abortable): Promise<ShlinkShortUrl>;
    getShortUrl({ shortCode, domain }: ShlinkShortUrlIdentifier, { signal }?: Abortable): Promise<ShlinkShortUrl>;
    deleteShortUrl({ shortCode, domain }: ShlinkShortUrlIdentifier, { signal }?: Abortable): Promise<void>;
    updateShortUrl({ shortCode, domain }: ShlinkShortUrlIdentifier, { signal, ...data }: ShlinkEditShortUrlData & Abortable): Promise<ShlinkShortUrl>;
    getShortUrlRedirectRules({ shortCode, domain }: ShlinkShortUrlIdentifier, { signal }?: Abortable): Promise<ShlinkRedirectRulesList>;
    setShortUrlRedirectRules({ shortCode, domain }: ShlinkShortUrlIdentifier, { signal, ...data }: ShlinkSetRedirectRulesData & Abortable): Promise<ShlinkRedirectRulesList>;
    getVisitsOverview({ signal }?: Abortable): Promise<ShlinkVisitsOverview>;
    getShortUrlVisits({ shortCode, domain }: ShlinkShortUrlIdentifier, { signal, ...params }?: ShlinkVisitsParams & Abortable): Promise<ShlinkVisitsList>;
    getTagVisits(tag: string, { signal, ...params }?: ShlinkWithDomainVisitsParams & Abortable): Promise<ShlinkVisitsList>;
    getDomainVisits(domain: string, { signal, ...params }?: ShlinkVisitsParams & Abortable): Promise<ShlinkVisitsList>;
    getOrphanVisits({ signal, ...params }?: ShlinkOrphanVisitsParams & Abortable): Promise<ShlinkVisitsList>;
    getNonOrphanVisits({ signal, ...params }?: ShlinkWithDomainVisitsParams & Abortable): Promise<ShlinkVisitsList>;
    deleteShortUrlVisits({ shortCode, domain }: ShlinkShortUrlIdentifier, { signal }?: Abortable): Promise<ShlinkDeleteVisitsResult>;
    deleteOrphanVisits({ signal }?: Abortable): Promise<ShlinkDeleteVisitsResult>;
    listTags({ signal }?: Abortable): Promise<ShlinkTagsList>;
    tagsStats({ signal }?: Abortable): Promise<ShlinkTagsStatsList>;
    deleteTags(tags: string[], { signal }?: Abortable): Promise<{
        tags: string[];
    }>;
    editTag({ oldName, newName }: ShlinkRenaming, { signal }?: Abortable): Promise<ShlinkRenaming>;
    listDomains({ signal }?: Abortable): Promise<ShlinkDomainsList>;
    editDomainRedirects(domainRedirects: ShlinkEditDomainRedirects, { signal }?: Abortable): Promise<ShlinkDomainRedirects>;
    health({ domain, signal }?: {
        domain?: string;
    } & Abortable): Promise<ShlinkHealth>;
    mercureInfo({ signal }?: Abortable): Promise<ShlinkMercureInfo>;
}
