import QtQuick
import qs
import qs.components

// ‹ 2 / 5 ›: the pages of a list the sidecar pages
Row {
    id: root

    property int page: 0
    property int pages: 1
    signal go(int page)

    spacing: 12
    visible: pages > 1
    Btn { small: true; text: "‹"; enabled: root.page > 0; onClicked: root.go(root.page - 1); Accessible.name: "Previous page" }
    Lb { anchors.verticalCenter: parent.verticalCenter; text: `${root.page + 1} / ${root.pages}` }
    Btn { small: true; text: "›"; enabled: root.page < root.pages - 1; onClicked: root.go(root.page + 1); Accessible.name: "Next page" }
}
