import QtQuick
import qs
import qs.components

// About: Hanami is a modified version of Roamies by Ken Kai. The licence, the copyright, where the source is and the
// original author stay here, as in the web panel (AGPL-3.0-only, NOTICE)
Column {
    id: root

    readonly property var s: Hanami.state
    readonly property string src: s?.repo ? `https://github.com/${s.repo}` : ""
    readonly property var ken: [
        ["Skool", "Learn with Ken, or support him", "https://www.skool.com/kenkai", "Open Ken Kai's Skool community"],
        ["YouTube", "@kenkaidoesai", "https://www.youtube.com/@kenkaidoesai", "Open Ken Kai's YouTube channel"],
        ["TikTok", "@ggkenkai", "https://www.tiktok.com/@ggkenkai", "Open Ken Kai's TikTok"],
        ["Roamies source code", "The original, open source under AGPL-3.0", "https://github.com/KenKaiii/Roamies", "Open the original Roamies source code on GitHub"]
    ]
    function open(url) { Hanami.send({ type: "open_link", url: url }); }

    width: parent?.width ?? 0
    spacing: 30

    Group {
        title: "Hanami"
        desc: "Hanami — a modified version of Roamies by Ken Kai (KenKaiii/Roamies)."
        Setting {
            label: "License"
            hint: "AGPL-3.0-only. The full text is in the LICENSE file that comes with the source; what changed is in NOTICE."
            Lnk {
                text: "Read"
                Accessible.name: "Read the GNU Affero General Public License, version 3"
                onClicked: root.open("https://www.gnu.org/licenses/agpl-3.0.html")
            }
        }
        Setting {
            label: "Copyright"
            hint: "Roamies: copyright Ken Kai and the Roamies contributors. Hanami changes: copyright their authors. All under AGPL-3.0-only."
        }
        Setting {
            label: "Source code"
            hint: root.src ? `Hanami's source is available at github.com/${root.s.repo}`
                : "Hanami's source is available from whoever gave you this copy; its repository link shows here once set."
            Lnk { visible: !!root.src; text: "Open"; Accessible.name: "Open Hanami's source code on GitHub"; onClicked: root.open(root.src) }
        }
        Setting {
            visible: !!root.s?.update?.off
            label: "Updates"
            hint: "Updates come from Hanami's own releases once its repository is set. This copy doesn't check for updates."
        }
    }

    Group {
        title: "Original author"
        // Ken, as the web panel's card: drawn (Hanami draws him), or his initials until he is
        Row {
            spacing: 16
            LookSprite {
                id: kenArt
                anchors.verticalCenter: parent.verticalCenter
                visible: ready
                look: "ken"
            }
            Rectangle {
                visible: !kenArt.ready
                width: 56
                height: 56
                radius: 28
                color: Theme.s2
                Num { anchors.centerIn: parent; text: "KK"; font.pixelSize: 26 }
            }
            Column {
                anchors.verticalCenter: parent.verticalCenter
                spacing: 2
                Text { text: "Ken Kai"; font.family: Theme.ui; font.pixelSize: 18; font.weight: Font.Medium; color: Theme.fg }
                Text { text: "Creator of Roamies"; font.family: Theme.ui; font.pixelSize: 13; color: Theme.grey }
            }
        }
        Repeater {
            model: root.ken
            Setting {
                id: k
                required property var modelData
                label: modelData[0]
                hint: modelData[1]
                Lnk { text: "Open"; Accessible.name: k.modelData[3]; onClicked: root.open(k.modelData[2]) }
            }
        }
    }

    Group {
        title: "Help"
        Flow {
            width: parent.width
            spacing: 22
            Lnk { text: "Setup guide"; onClicked: Hanami.act("setup", true) }
            Lnk { text: "Show logs"; onClicked: Hanami.act("logs") }
            Lnk { text: "Save diagnostics"; Accessible.name: "Save a diagnostics file to send when something goes wrong"; onClicked: Hanami.act("diagnostics") }
        }
    }
}
