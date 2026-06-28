// =============================================================================
//  Maersk 실시간 추적 프록시  (Supabase Edge Function · Deno)
// -----------------------------------------------------------------------------
//  브라우저 → (이 함수) → Maersk OAuth2 → Track & Trace Events(DCSA v2.2) → 정규화
//  출력 형식은 kmtc-track과 동일 → 같은 지도 뷰(vtRender) 그대로 사용.
//
//  필요한 시크릿:
//    MAERSK_CONSUMER_KEY   (App의 Consumer Key = client_id)
//    MAERSK_CLIENT_SECRET  (App의 Consumer Secret)
//
//  배포:  supabase functions deploy maersk-track --no-verify-jwt
//  호출:  GET .../functions/v1/maersk-track?ref=<부킹/BL/컨테이너>
// =============================================================================

const OAUTH_URL = "https://api.maersk.com/customer-identity/oauth/v2/access_token";
const EVENTS_URL = "https://api.maersk.com/track-and-trace-private/events";

const CONSUMER_KEY = Deno.env.get("MAERSK_CONSUMER_KEY") ?? "";
const CLIENT_SECRET = Deno.env.get("MAERSK_CLIENT_SECRET") ?? "";

// ── 항구 좌표 폴백 (DCSA 응답에 좌표 없을 때 UN/LOCODE로 조회) ────────────────
//    응답 location.latitude/longitude가 있으면 그걸 우선 사용.
const PORT: Record<string, [number, number]> = {
  KRPUS: [129.04, 35.10], KRINC: [126.61, 37.46], KRKAN: [127.70, 34.94],
  CNSHA: [121.47, 31.23], CNNGB: [121.54, 29.87], CNTAO: [120.32, 36.07],
  CNYTN: [114.27, 22.57], CNDLC: [121.65, 38.95], HKHKG: [114.16, 22.30],
  SGSIN: [103.83, 1.26], MYPKG: [101.36, 2.998], MYTPP: [100.62, 3.05],
  JPTYO: [139.77, 35.62], JPYOK: [139.66, 35.45], JPOSA: [135.43, 34.65],
  JPNGO: [136.88, 35.05], JPKOB: [135.21, 34.68],
  VNHPH: [106.68, 20.86], VNSGN: [106.70, 10.77], VNVUT: [107.08, 10.40],
  THLCB: [100.88, 13.08], THBKK: [100.58, 13.70], IDJKT: [106.88, -6.10],
  INNSA: [72.95, 18.95], INMAA: [80.29, 13.08], INMUN: [72.84, 18.96],
  AEJEA: [55.03, 25.01], AEAUH: [54.37, 24.51],
  NLRTM: [4.40, 51.95], DEHAM: [9.93, 53.54], BEANR: [4.40, 51.26],
  GBFXT: [1.33, 51.95], FRLEH: [0.11, 49.48], ESVLC: [-0.32, 39.45],
  ESALG: [-5.44, 36.13], ITGOA: [8.92, 44.40], GRPIR: [23.63, 37.94],
  USLAX: [-118.27, 33.74], USLGB: [-118.20, 33.75], USNYC: [-74.05, 40.67],
  USSAV: [-81.14, 32.09], USHOU: [-95.27, 29.73], USOAK: [-122.33, 37.80],
  USSEA: [-122.34, 47.60], USCHS: [-79.92, 32.78],
  PAMIT: [-79.81, 9.36], PABLB: [-79.56, 9.97], MXZLO: [-104.32, 19.05],
  BRSSZ: [-46.30, -23.98], EGPSD: [32.31, 31.25], EGSUZ: [32.55, 29.97],
  LKCMB: [79.85, 6.95], BDCGP: [91.83, 22.30], PKKHI: [66.97, 24.80],
  TWKHH: [120.30, 22.61], TWKEL: [121.74, 25.13], PHMNL: [120.96, 14.60],
  AUSYD: [151.20, -33.85], AUMEL: [144.92, -37.83], ZADUR: [31.03, -29.87],
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
function fmtTime(s: string): string {           // ISO 8601 → "YYYY-MM-DD HH:mm"
  if (!s) return "";
  const d = String(s);
  return d.length >= 16 ? `${d.slice(0,10)} ${d.slice(11,16)}` : d;
}
// 번호 종류 자동판별
function detectParam(ref: string): string {
  if (/^[A-Z]{4}\d{7}$/.test(ref)) return "equipmentReference";   // 컨테이너
  return "carrierBookingReference";                                // 부킹(기본)
}

// ── OAuth 토큰 (메모리 캐시, 2시간 유효 → 만료 5분 전 갱신) ───────────────────
let _token = "", _tokenExp = 0;
async function getToken(): Promise<string> {
  if (_token && _tokenExp > Date.now()) return _token;
  const body = new URLSearchParams({
    client_id: CONSUMER_KEY, client_secret: CLIENT_SECRET, grant_type: "client_credentials",
  });
  const r = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Consumer-Key": CONSUMER_KEY },
    body,
  });
  if (!r.ok) throw new Error(`oauth ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  _token = j.access_token;
  _tokenExp = Date.now() + ((j.expires_in ?? 7200) - 300) * 1000;
  return _token;
}

// ── Maersk Track & Trace Events 조회 ─────────────────────────────────────────
async function fetchEvents(param: string, ref: string): Promise<any[]> {
  const token = await getToken();
  const url = `${EVENTS_URL}?${param}=${encodeURIComponent(ref)}`;
  const r = await fetch(url, {
    headers: { "Consumer-Key": CONSUMER_KEY, "Authorization": `Bearer ${token}`, "Accept": "application/json" },
  });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`events ${r.status}: ${(await r.text()).slice(0,200)}`);
  const data = await r.json();
  // DCSA 표준은 배열. 혹시 래핑돼 있으면 흔한 키들에서 추출.
  if (Array.isArray(data)) return data;
  return data?.events ?? data?.eventList ?? data?.transportEvents ?? [];
}

// 좌표 얻기: 응답 location 우선 → UN/LOCODE 폴백 → null
function coordOf(loc: any): [number, number] | null {
  const lat = parseFloat(loc?.latitude), lng = parseFloat(loc?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return [lng, lat];
  const un = loc?.UNLocationCode || loc?.unLocationCode;
  if (un && PORT[un]) return PORT[un];
  return null;
}
function locName(loc: any): string {
  return loc?.locationName || loc?.UNLocationCode || loc?.unLocationCode || loc?.address?.city || "";
}

// DCSA 이벤트 코드 → 뷰어 이벤트 타입
function viewerType(ev: any): string {
  if (ev.transportEventTypeCode === "DEPA") return "VSL_DEP";
  if (ev.transportEventTypeCode === "ARRI") return "VSL_ARR";
  const e = ev.equipmentEventTypeCode;
  if (e === "LOAD") return "LOADED";
  if (e === "DISC") return "DISCHARGE";
  if (e === "GTIN") return "IN_GATE";
  if (e === "GTOT") return "GATE_OUT";
  return ev.shipmentEventTypeCode ? "SHIPMENT" : "EVENT";
}

// ── 정규화: DCSA 이벤트 배열 → kmtc-track과 동일한 뷰어 형식 ──────────────────
function normalize(events: any[], queryRef: string) {
  if (!events.length) throw new Error("조회 결과 없음 (이벤트 0개)");

  // 시간순 정렬
  const sorted = [...events].sort((a, b) =>
    String(a.eventDateTime || "").localeCompare(String(b.eventDateTime || "")));

  // 컨테이너 / 문서 번호 수집
  const containers = [...new Set(sorted.map((e) => e.equipmentReference).filter(Boolean))];
  let booking = "", mbl = "";
  for (const e of sorted) {
    const refs = e.documentReferences || [];
    for (const d of refs) {
      if (d.documentReferenceType === "BKG" && !booking) booking = d.documentReferenceValue;
      if (d.documentReferenceType === "TRD" && !mbl) mbl = d.documentReferenceValue;
    }
    if (!booking && e.carrierBookingReference) booking = e.carrierBookingReference;
    if (!mbl && e.transportDocumentReference) mbl = e.transportDocumentReference;
  }

  // 기항지(transportCall) 순서대로 수집 → 항구 목록
  const callSeq: any[] = [];
  const seen = new Set<string>();
  for (const e of sorted) {
    const tc = e.transportCall; if (!tc) continue;
    const loc = tc.location || {};
    const un = loc.UNLocationCode || loc.unLocationCode || locName(loc);
    const seq = tc.transportCallSequenceNumber;
    const key = `${un}|${seq ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    callSeq.push({ tc, loc, un, seq, coord: coordOf(loc),
      vessel: tc.vessel?.vesselName || "", voyage: tc.exportVoyageNumber || tc.importVoyageNumber || "" });
  }
  // 시퀀스 번호 있으면 그걸로 정렬 (없으면 등장순 유지)
  if (callSeq.every((c) => c.seq != null)) callSeq.sort((a, b) => a.seq - b.seq);

  const withCoord = callSeq.filter((c) => c.coord);
  const ports = withCoord.map((c, i) => ({
    name: locName(c.loc),
    role: i === 0 ? "origin" : (i === withCoord.length - 1 ? "destination" : "transship"),
    lat: c.coord![1], lng: c.coord![0],
  }));

  // 현재 위치: 마지막 ACT(실제발생) 이벤트의 기항지
  let lastActUn = "";
  for (const e of sorted) {
    if (e.eventClassifierCode === "ACT" && e.transportCall) {
      const loc = e.transportCall.location || {};
      lastActUn = loc.UNLocationCode || loc.unLocationCode || locName(loc);
    }
  }
  const path = withCoord.map((c) => [c.coord![1], c.coord![0]]);
  let currentVertex = 0;
  if (lastActUn) {
    const idx = withCoord.findIndex((c) => c.un === lastActUn);
    if (idx >= 0) currentVertex = idx;
  }

  // 도착 예정(ETA): 목적지의 EST/PLN 도착 이벤트
  let eta = "";
  for (const e of sorted) {
    if (e.transportEventTypeCode === "ARRI" && e.eventClassifierCode !== "ACT") eta = fmtTime(e.eventDateTime);
  }
  if (!eta && sorted.length) eta = fmtTime(sorted[sorted.length - 1].eventDateTime);

  const mainVessel = withCoord.find((c) => c.vessel)?.vessel || "";
  const mainVoyage = withCoord.find((c) => c.voyage)?.voyage || "";

  // 타임라인 이벤트 (운송/장비 위주, 시간 있는 것만)
  const tlEvents = sorted
    .filter((e) => e.transportEventTypeCode || e.equipmentEventTypeCode)
    .map((e) => ({
      type: viewerType(e),
      place: locName(e.transportCall?.location || {}),
      time: fmtTime(e.eventDateTime),
      tz: "",
      vessel: e.transportCall?.vessel?.vesselName
        ? `${e.transportCall.vessel.vesselName}/${e.transportCall.exportVoyageNumber || e.transportCall.importVoyageNumber || ""}`
        : "",
      future: e.eventClassifierCode !== "ACT",
    }));

  const arrived = currentVertex >= withCoord.length - 1 && withCoord.length > 0
    && sorted.some((e) => e.transportEventTypeCode === "ARRI" && e.eventClassifierCode === "ACT");

  return {
    carrier: "MAERSK", scac: "MAEU",
    mbl, booking, queryRef,
    containers, eta,
    originName: ports[0]?.name || "", destName: ports[ports.length - 1]?.name || "",
    ports,
    legs: [{ vessel: mainVessel, voyage: mainVoyage, path }],
    currentLegIdx: 0, currentVertex,
    positionTs: `${eta ? eta + " · " : ""}${arrived ? "도착" : "운송중"} · Maersk DCSA`,
    events: tlEvents,
  };
}

// ── 엔트리포인트 + 캐시 ──────────────────────────────────────────────────────
const CACHE = new Map<string, { data: any; exp: number }>();
const TTL = 20 * 60 * 1000;   // 20분

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!CONSUMER_KEY || !CLIENT_SECRET) {
      return json({ error: "MAERSK_CONSUMER_KEY / MAERSK_CLIENT_SECRET 시크릿이 설정되지 않았습니다" }, 500);
    }
    const url = new URL(req.url);
    const ref = url.searchParams.get("ref")?.trim();
    if (!ref) return json({ error: "ref(부킹/BL/컨테이너 번호) 파라미터가 필요합니다" }, 400);
    const nocache = url.searchParams.get("nocache") === "1";
    const key = ref.toUpperCase();

    if (!nocache) {
      const hit = CACHE.get(key);
      if (hit && hit.exp > Date.now()) return json({ ...hit.data, cached: true });
    }

    // 컨테이너면 equipmentReference, 아니면 부킹 → 비면 B/L 로 재시도
    let param = detectParam(ref);
    let events = await fetchEvents(param, ref);
    if (!events.length && param === "carrierBookingReference") {
      param = "transportDocumentReference";
      events = await fetchEvents(param, ref);
    }
    if (!events.length) return json({ error: `'${ref}' 추적 정보를 찾지 못했습니다. (부킹 당사자 고객코드인지 확인)`, ref }, 404);

    const data = normalize(events, ref);
    CACHE.set(key, { data, exp: Date.now() + TTL });
    return json(data);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
