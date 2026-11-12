import QtQuick
import qs
import qs.components

// a group of settings: a heading (and how many), a line about it, then its rows
Column {
    id: root

    property string title
    property string desc
    property var n: null
    default property alias body: inner.data

    width: parent?.width ?? 0
    spacing: 12

    Column {
        width: parent.width
        spacing: 4
        visible: !!root.title || !!root.desc
        Row {
            spacing: 10
            visible: !!root.title
            Lb { text: root.title; px: 12; color: Theme.fg }
            Lb { visible: root.n !== null; text: String(root.n); px: 12 }
        }
        Text {
            width: parent.width
            visible: !!root.desc
            text: root.desc
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            font { family: Theme.ui; pixelSize: 13 }
            color: Theme.grey
        }
    }
    Column {
        id: inner
        width: parent.width
        spacing: 10
    }
}
