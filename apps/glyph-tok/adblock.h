#pragma once

// Ad blocker: Brave's engine (adblock-rust, ./adblock, a Rust staticlib) behind Qt.
// - network: every request goes through interceptRequest → blocked, redirected to a harmless stub, or let through
// - cosmetic: per-hostname hide selectors + scriptlets (uBlock / Brave resources) as one user script, exposed to QML
//   as `script` and injected at document creation in every frame (Main.qml)
// Without lists (~/.local/share/glyph-tok/adblock, filled by glyph-tok-adblock-update) it does nothing.

#include <QHash>
#include <QStringList>
#include <QWebEngineUrlRequestInterceptor>

struct Blocker; // tok_adblock (Rust)

class Adblock : public QWebEngineUrlRequestInterceptor {
    Q_OBJECT
    Q_PROPERTY(bool enabled READ enabled CONSTANT)
    Q_PROPERTY(QString script READ script NOTIFY scriptChanged)
    Q_PROPERTY(int blocked READ blocked NOTIFY blockedChanged)

public:
    explicit Adblock(const QString &dir, QObject *parent = nullptr);
    ~Adblock() override;

    bool enabled() const { return m_ab != nullptr; }
    QString script() const { return m_script; }
    int blocked() const { return m_blocked; }

    void interceptRequest(QWebEngineUrlRequestInfo &info) override;

    // the QML WebEngineProfile: sets this as its request interceptor
    Q_INVOKABLE void attach(QObject *profile);
    // hosts that should have their cosmetic rules before the first page loads (the profiles' sites)
    Q_INVOKABLE void prime(const QStringList &urls);

signals:
    void scriptChanged();
    void blockedChanged();

private:
    void addHost(const QUrl &url);
    void rebuild();

    Blocker *m_ab = nullptr;
    QString m_script;
    int m_blocked = 0;
    // hostname → the JS for that host (style + scriptlets); most recent last, capped
    QHash<QString, QString> m_hosts;
    QStringList m_order;
    bool m_pending = false;
};
