#include "adblock.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTimer>
#include <QUrl>
#include <QWebEngineUrlRequestInfo>
#include <QtWebEngineQuick/QQuickWebEngineProfile>

extern "C" {
Blocker *tok_ab_open(const char *dir);
int tok_ab_check(const Blocker *b, const char *url, const char *source, const char *kind, char **redirect);
char *tok_ab_cosmetic(const Blocker *b, const char *url);
void tok_ab_free_str(char *s);
void tok_ab_close(Blocker *b);
}

namespace {
// hosts whose rules stay in the user script; the oldest drop out (it's parsed on every page, keep it small)
constexpr int kMaxHosts = 24;

// adblock-rust request types (the same names as uBlock / Brave filter options)
const char *kind(QWebEngineUrlRequestInfo::ResourceType t) {
    using I = QWebEngineUrlRequestInfo;
    switch (t) {
    case I::ResourceTypeSubFrame: case I::ResourceTypeNavigationPreloadSubFrame: return "sub_frame";
    case I::ResourceTypeStylesheet: return "stylesheet";
    case I::ResourceTypeScript: case I::ResourceTypeWorker: case I::ResourceTypeSharedWorker:
    case I::ResourceTypeServiceWorker: return "script";
    case I::ResourceTypeImage: case I::ResourceTypeFavicon: return "image";
    case I::ResourceTypeFontResource: return "font";
    case I::ResourceTypeObject: case I::ResourceTypePluginResource: return "object";
    case I::ResourceTypeMedia: return "media";
    case I::ResourceTypeXhr: case I::ResourceTypeJson: return "xmlhttprequest";
    case I::ResourceTypePing: case I::ResourceTypeCspReport: return "ping";
    case I::ResourceTypeWebSocket: return "websocket";
    default: return "other";
    }
}

QString jsString(const QString &s) {
    const QByteArray a = QJsonDocument(QJsonArray{s}).toJson(QJsonDocument::Compact);
    return QString::fromUtf8(a.mid(1, a.size() - 2)); // ["…"] → "…"
}
} // namespace

Adblock::Adblock(const QString &dir, QObject *parent) : QWebEngineUrlRequestInterceptor(parent) {
    m_ab = tok_ab_open(dir.toUtf8().constData());
}

Adblock::~Adblock() { tok_ab_close(m_ab); }

void Adblock::attach(QObject *profile) {
    if (auto *p = qobject_cast<QQuickWebEngineProfile *>(profile); p && m_ab) p->setUrlRequestInterceptor(this);
}

void Adblock::interceptRequest(QWebEngineUrlRequestInfo &info) {
    if (!m_ab) return;
    const auto type = info.resourceType();
    const QUrl url = info.requestUrl();
    if (url.scheme() != "http" && url.scheme() != "https") return;
    // pages themselves are never blocked; a new page's host gets its cosmetic rules
    if (type == QWebEngineUrlRequestInfo::ResourceTypeMainFrame
        || type == QWebEngineUrlRequestInfo::ResourceTypeNavigationPreloadMainFrame) {
        addHost(url);
        return;
    }
    if (type == QWebEngineUrlRequestInfo::ResourceTypeSubFrame) addHost(url);

    QUrl source = info.firstPartyUrl();
    if (source.isEmpty()) source = info.initiator();
    char *to = nullptr;
    const int r = tok_ab_check(m_ab, url.toEncoded().constData(), source.toEncoded().constData(), kind(type), &to);
    if (r == 2 && to) {
        info.redirect(QUrl(QString::fromUtf8(to)));
        tok_ab_free_str(to);
    } else if (r == 1) {
        info.block(true);
    } else {
        return;
    }
    ++m_blocked;
    emit blockedChanged();
}

void Adblock::prime(const QStringList &urls) {
    for (const QString &u : urls) addHost(QUrl(u));
}

void Adblock::addHost(const QUrl &url) {
    const QString host = url.host();
    if (!m_ab || host.isEmpty()) return;
    if (m_hosts.contains(host)) {
        m_order.removeOne(host);
        m_order.append(host);
        return;
    }
    char *c = tok_ab_cosmetic(m_ab, url.toEncoded().constData());
    if (!c) return;
    const QJsonObject o = QJsonDocument::fromJson(QByteArray(c)).object();
    tok_ab_free_str(c);

    // one rule per selector: an invalid selector then only loses its own rule, not the whole sheet
    QString css;
    for (const auto &s : o.value("hide").toArray()) css += s.toString() + "{display:none!important}\n";
    const QString scriptlets = o.value("script").toString();
    QString js;
    if (!css.isEmpty())
        js += QString("try{const s=new CSSStyleSheet();s.replaceSync(%1);"
                      "document.adoptedStyleSheets=[...document.adoptedStyleSheets,s];}catch(e){}\n").arg(jsString(css));
    js += scriptlets;
    m_hosts.insert(host, js);
    m_order.append(host);
    while (m_order.size() > kMaxHosts) m_hosts.remove(m_order.takeFirst());

    // the interceptor runs while Chromium is starting the navigation: publish on the next event loop turn
    if (!m_pending) {
        m_pending = true;
        QTimer::singleShot(0, this, &Adblock::rebuild);
    }
}

void Adblock::rebuild() {
    m_pending = false;
    QString s = "(()=>{const H={\n";
    for (const QString &h : m_order) {
        const QString &js = m_hosts[h];
        if (js.isEmpty()) continue;
        s += jsString(h) + ":()=>{\n" + js + "\n},\n";
    }
    s += "};const f=H[location.hostname];if(f)f();})();";
    if (s != m_script) {
        m_script = s;
        emit scriptChanged();
    }
}
