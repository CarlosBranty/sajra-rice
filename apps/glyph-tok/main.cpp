// glyph-tok — TikTok en una ventana tipo celular con el estilo de glyph.
// Quickshell no puede cargar Qt WebEngine, así que vive como proceso aparte: este main solo
//   1) inicializa WebEngine (debe ir antes de QGuiApplication),
//   2) mantiene una sola instancia: volver a lanzarlo manda "toggle" (o el argumento) por un socket local,
//   3) expone a QML la paleta de glyph (~/.local/state/rice/glyph/palette.json, la escribe shell.qml), run()/exec()
//      y el estado (~/.local/state/glyph-tok/state.json: modo fijo/flotante y ancho; glyph lo lee para reservar la franja).
#include <QDir>
#include <QDirIterator>
#include <QVersionNumber>
#include <QFile>
#include <QFileInfo>

#include "adblock.h"
#include <QFileSystemWatcher>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QLocalServer>
#include <QLocalSocket>
#include <QProcess>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QStandardPaths>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <cstring>
#include <cstdlib>

class Host : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantMap palette READ palette NOTIFY paletteChanged)
    Q_PROPERTY(QVariantMap state READ state WRITE setState NOTIFY stateChanged)

public:
    Host(QString path, QString statePath) : m_path(std::move(path)), m_statePath(std::move(statePath)) {
        QFile sf(m_statePath);
        if (sf.open(QIODevice::ReadOnly)) m_state = QJsonDocument::fromJson(sf.readAll()).toVariant().toMap();
        connect(&m_watch, &QFileSystemWatcher::fileChanged, this, &Host::reload);
        // el directorio también: el shell reescribe el archivo y el watcher del archivo se pierde
        connect(&m_watch, &QFileSystemWatcher::directoryChanged, this, &Host::reload);
        QDir().mkpath(QFileInfo(m_path).absolutePath());
        m_watch.addPath(QFileInfo(m_path).absolutePath());
        reload();
    }
    QVariantMap palette() const { return m_pal; }
    QVariantMap state() const { return m_state; }
    void setState(const QVariantMap &st) {
        if (st == m_state) return;
        m_state = st;
        QDir().mkpath(QFileInfo(m_statePath).absolutePath());
        // en el mismo archivo, no temporal+renombrar: el FileView de glyph vigila el inodo y tras un rename se queda
        // mirando el viejo. Es un JSON de una línea; una lectura a medias la descarta el try de glyph y llega la siguiente
        QFile f(m_statePath);
        if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            f.write(QJsonDocument::fromVariant(m_state).toJson(QJsonDocument::Compact));
            f.close();
        }
        emit stateChanged();
    }

    // síncrono, para hyprctl -j (rápido); la salida estándar como texto
    Q_INVOKABLE QString exec(const QStringList &cmd) {
        if (cmd.isEmpty()) return {};
        QProcess p;
        p.start(cmd.first(), cmd.mid(1));
        if (!p.waitForFinished(2000)) return {};
        return QString::fromUtf8(p.readAllStandardOutput());
    }

    Q_INVOKABLE void run(const QStringList &cmd) {
        if (!cmd.isEmpty()) QProcess::startDetached(cmd.first(), cmd.mid(1));
    }

signals:
    void paletteChanged();
    void stateChanged();
    void command(const QString &cmd); // "toggle" | "show" | "hide" desde otra instancia

public slots:
    void reload() {
        QFile f(m_path);
        if (!f.open(QIODevice::ReadOnly)) return;
        const auto m = QJsonDocument::fromJson(f.readAll()).toVariant().toMap();
        if (!m.isEmpty() && m != m_pal) {
            m_pal = m;
            emit paletteChanged();
        }
        if (!m_watch.files().contains(m_path)) m_watch.addPath(m_path);
    }

private:
    QString m_path;
    QString m_statePath;
    QVariantMap m_pal;
    QVariantMap m_state;
    QFileSystemWatcher m_watch;
};

// socket de la instancia única: ruta completa en XDG_RUNTIME_DIR (QLocalServer la acepta tal cual)
static QString sockPath() {
    const char *rt = getenv("XDG_RUNTIME_DIR");
    return QString::fromLocal8Bit(rt && *rt ? rt : "/tmp") + "/glyph-tok.sock";
}

// ¿ya hay una instancia? mandarle el comando con un socket Unix pelado, antes de levantar Qt y WebEngine:
// los atajos (Super+↑/↓ → next/prev, Super+Alt+T → toggle) responden al instante
static bool sendToRunning(const QByteArray &cmd) {
    const QByteArray path = sockPath().toLocal8Bit();
    const int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return false;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    if (path.size() >= int(sizeof(addr.sun_path))) { ::close(fd); return false; }
    memcpy(addr.sun_path, path.constData(), path.size());
    bool ok = ::connect(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) == 0
              && ::write(fd, cmd.constData(), cmd.size()) == cmd.size();
    ::close(fd);
    return ok;
}

// Widevine (el DRM de Netflix): Qt WebEngine lo carga si le pasan la ruta del CDM, pero Arch no lo trae. Usamos el
// que ya descargó Zen/Firefox (gmp-widevinecdm/<versión>/, se actualiza solo con el navegador), el más nuevo; uno puesto a
// mano en ~/.local/share/glyph-tok/WidevineCdm/ gana. Los perfiles de Zen llevan espacios ("… (release)") y
// QTWEBENGINE_CHROMIUM_FLAGS se parte por espacios: se pasa un enlace sin espacios a ese archivo
static QString widevine() {
    const QString home = QDir::homePath();
    const QString own = home + "/.local/share/glyph-tok/WidevineCdm/libwidevinecdm.so";
    if (QFileInfo(own).isFile() && !QFileInfo(own).isSymLink()) return own;
    QString best;
    QVersionNumber bestV;
    for (const QString &base : {home + "/.config/zen", home + "/.zen", home + "/.mozilla/firefox", home + "/.config/mozilla/firefox"}) {
        for (const QFileInfo &prof : QDir(base).entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot)) {
            for (const QFileInfo &ver : QDir(prof.filePath() + "/gmp-widevinecdm").entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot)) {
                const QString so = ver.filePath() + "/libwidevinecdm.so";
                const QVersionNumber v = QVersionNumber::fromString(ver.fileName());
                if (QFileInfo(so).isFile() && (best.isEmpty() || v > bestV)) { best = so; bestV = v; }
            }
        }
    }
    if (best.isEmpty()) return {};
    QDir().mkpath(QFileInfo(own).absolutePath());
    if (QFileInfo(own).symLinkTarget() != best) { QFile::remove(own); QFile::link(best, own); }
    return own;
}

int main(int argc, char *argv[]) {
    const QByteArray arg = argc > 1 ? QByteArray(argv[1]) : QByteArrayLiteral("toggle");
    if (sendToRunning(arg)) return 0;

    // decodificar video con la GPU (VA-API, Intel): menos CPU y batería. Respeta flags puestos a mano
    QByteArray flags = qgetenv("QTWEBENGINE_CHROMIUM_FLAGS");
    if (flags.isEmpty())
        flags = "--enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,VaapiIgnoreDriverChecks "
                "--ignore-gpu-blocklist --enable-gpu-rasterization";
    if (!flags.contains("--widevine-path")) {
        const QString cdm = widevine();
        if (!cdm.isEmpty()) flags += " --widevine-path=" + cdm.toLocal8Bit();
    }
    qputenv("QTWEBENGINE_CHROMIUM_FLAGS", flags);

    QtWebEngineQuick::initialize();
    QGuiApplication app(argc, argv);
    app.setApplicationName("glyph-tok");
    app.setOrganizationName("glyph");
    app.setDesktopFileName("glyph-tok"); // app_id de Wayland → reglas de Hyprland por class

    const QString cmd = QString::fromLocal8Bit(arg);
    // sin instancia: comandos que solo tienen sentido con una abierta no la arrancan
    if (cmd == "next" || cmd == "prev" || cmd == "quit" || cmd == "hide" || cmd == "place" || cmd == "mode") return 0;
    const QString sock = sockPath();

    const QString home = QDir::homePath();
    const QString state = qEnvironmentVariable("XDG_STATE_HOME", home + "/.local/state");
    Host host(state + "/rice/glyph/palette.json", state + "/glyph-tok/state.json");

    QLocalServer::removeServer(sock);
    QLocalServer server;
    server.listen(sock);
    QObject::connect(&server, &QLocalServer::newConnection, [&] {
        QLocalSocket *c = server.nextPendingConnection();
        QObject::connect(c, &QLocalSocket::readyRead, [&host, c] {
            emit host.command(QString::fromUtf8(c->readAll()).trimmed());
            c->disconnectFromServer();
        });
        QObject::connect(c, &QLocalSocket::disconnected, c, &QObject::deleteLater);
    });

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("host", &host);
    engine.rootContext()->setContextProperty("startHidden", cmd == "hide");
    // ad blocker (Brave's engine): Main.qml attaches it to its profile and injects its cosmetic script
    Adblock adblock(qEnvironmentVariable("XDG_DATA_HOME", home + "/.local/share") + "/glyph-tok/adblock");
    engine.rootContext()->setContextProperty("adblock", &adblock);
    engine.rootContext()->setContextProperty("startApp", cmd); // "netflix" | "tiktok" abre ese perfil (Main lo ignora si no es uno)
    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed, &app, [] { QCoreApplication::exit(1); },
                     Qt::QueuedConnection);
    engine.loadFromModule("tok", "Main");
    return app.exec();
}

#include "main.moc"
