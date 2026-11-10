//#region src/api/utils.ts
var e = (e, t) => `${e}/rest/v${t}`, t = (e) => e.dir ? `${e.field}-${e.dir}` : void 0, n = ({ orderBy: e = {}, excludeMaxVisitsReached: n, excludePastValidUntil: r, ...i }) => ({
	...i,
	excludeMaxVisitsReached: n === !0 ? "true" : void 0,
	excludePastValidUntil: r === !0 ? "true" : void 0,
	orderBy: t(e)
}), r = (e, t) => {
	let [n, r] = e.split("://");
	if (!r) throw Error(`It is not possible to determine authority on "${e}" for replacement`);
	let [, ...i] = r.split("/");
	return `${n}://${t}${i.length ? `/${i.join("/")}` : ""}`;
}, i = (e = {}) => {
	let t = Object.entries(e).flatMap(([e, t]) => t == null ? [] : Array.isArray(t) ? t.map((t) => [`${e}[]`, t]) : [[e, t]]);
	return new URLSearchParams(t).toString();
}, a = class {
	#e;
	#t;
	#n;
	#r;
	constructor(e, t, n = {}) {
		this.#t = e, this.#n = t, this.#r = n, this.#e = 3;
	}
	async listShortUrls({ signal: e, ...t } = {}) {
		return this.#a({
			url: "/short-urls",
			query: n(t),
			signal: e
		}).then(({ shortUrls: e }) => e);
	}
	async createShortUrl({ signal: e, ...t }) {
		let n = Object.entries(t).reduce((e, [t, n]) => (n && (e[t] = n), e), {});
		return this.#a({
			url: "/short-urls",
			method: "POST",
			body: n,
			signal: e
		});
	}
	async getShortUrl({ shortCode: e, domain: t }, { signal: n } = {}) {
		return this.#a({
			url: `/short-urls/${e}`,
			query: { domain: t },
			signal: n
		});
	}
	async deleteShortUrl({ shortCode: e, domain: t }, { signal: n } = {}) {
		return this.#o({
			url: `/short-urls/${e}`,
			method: "DELETE",
			query: { domain: t },
			signal: n
		});
	}
	async updateShortUrl({ shortCode: e, domain: t }, { signal: n, ...r }) {
		return this.#a({
			url: `/short-urls/${e}`,
			method: "PATCH",
			query: { domain: t },
			body: r,
			signal: n
		});
	}
	async getShortUrlRedirectRules({ shortCode: e, domain: t }, { signal: n } = {}) {
		return this.#a({
			url: `/short-urls/${e}/redirect-rules`,
			method: "GET",
			query: { domain: t },
			signal: n
		});
	}
	async setShortUrlRedirectRules({ shortCode: e, domain: t }, { signal: n, ...r }) {
		return this.#a({
			url: `/short-urls/${e}/redirect-rules`,
			method: "POST",
			query: { domain: t },
			body: r,
			signal: n
		});
	}
	async getVisitsOverview({ signal: e } = {}) {
		return this.#a({
			url: "/visits",
			signal: e
		}).then(({ visits: e }) => e);
	}
	async getShortUrlVisits({ shortCode: e, domain: t }, { signal: n, ...r } = {}) {
		return this.#i({
			url: `/short-urls/${e}/visits`,
			query: {
				...r,
				domain: t
			},
			signal: n
		});
	}
	async getTagVisits(e, { signal: t, ...n } = {}) {
		return this.#i({
			url: `/tags/${e}/visits`,
			query: n,
			signal: t
		});
	}
	async getDomainVisits(e, { signal: t, ...n } = {}) {
		return this.#i({
			url: `/domains/${e}/visits`,
			query: n,
			signal: t
		});
	}
	async getOrphanVisits({ signal: e, ...t } = {}) {
		return this.#i({
			url: "/visits/orphan",
			query: t,
			signal: e
		});
	}
	async getNonOrphanVisits({ signal: e, ...t } = {}) {
		return this.#i({
			url: "/visits/non-orphan",
			query: t,
			signal: e
		});
	}
	async #i(e) {
		return this.#a(e).then(({ visits: e }) => e);
	}
	async deleteShortUrlVisits({ shortCode: e, domain: t }, { signal: n } = {}) {
		let r = t ? { domain: t } : void 0;
		return this.#a({
			method: "DELETE",
			url: `/short-urls/${e}/visits`,
			query: r,
			signal: n
		});
	}
	async deleteOrphanVisits({ signal: e } = {}) {
		return this.#a({
			method: "DELETE",
			url: "/visits/orphan",
			signal: e
		});
	}
	async listTags({ signal: e } = {}) {
		return this.#a({
			url: "/tags",
			signal: e
		}).then(({ tags: e }) => e);
	}
	async tagsStats({ signal: e } = {}) {
		return this.#a({
			url: "/tags/stats",
			signal: e
		}).then(({ tags: e }) => e);
	}
	async deleteTags(e, { signal: t } = {}) {
		return this.#o({
			url: "/tags",
			method: "DELETE",
			query: { tags: e },
			signal: t
		}).then(() => ({ tags: e }));
	}
	async editTag({ oldName: e, newName: t }, { signal: n } = {}) {
		return this.#o({
			url: "/tags",
			method: "PUT",
			body: {
				oldName: e,
				newName: t
			},
			signal: n
		}).then(() => ({
			oldName: e,
			newName: t
		}));
	}
	async listDomains({ signal: e } = {}) {
		return this.#a({
			url: "/domains",
			signal: e
		}).then(({ domains: e }) => e);
	}
	async editDomainRedirects(e, { signal: t } = {}) {
		return this.#a({
			url: "/domains/redirects",
			method: "PATCH",
			body: e,
			signal: t
		});
	}
	async health({ domain: e, signal: t } = {}) {
		return this.#a({
			url: "/health",
			domain: e,
			signal: t
		});
	}
	async mercureInfo({ signal: e } = {}) {
		return this.#a({
			url: "/mercure-info",
			signal: e
		});
	}
	async #a(e) {
		return this.#t.jsonRequest(...this.#s(e));
	}
	async #o(e) {
		return this.#t.emptyRequest(...this.#s(e));
	}
	#s({ url: t, method: n = "GET", query: a, body: o, domain: s, signal: c }) {
		let l = i(a ?? {}), u = l ? `?${l}` : "";
		return [`${e(s ? r(this.#n.baseUrl, s) : this.#n.baseUrl, this.#e)}${t}${u}`, {
			method: n,
			body: o && JSON.stringify(o),
			headers: { "X-Api-Key": this.#n.apiKey },
			credentials: this.#r.requestCredentials,
			signal: c
		}];
	}
};
//#endregion
export { a as ShlinkApiClient };
