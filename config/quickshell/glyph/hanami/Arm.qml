import QtQuick
import qs

// asks first in the same spot: the first press turns it into Confirm (for 4 s), the second sends the action
Lnk {
    id: root

    property string label
    property string yes: "Confirm"
    property string k      // which one is armed (Hanami.arm)
    property string action // the menu id it sends
    readonly property bool on: Hanami.arm === k

    text: on ? yes : label
    danger: true
    font.weight: on ? Font.Bold : Font.Medium
    onClicked: Hanami.armed(k, action)
}
