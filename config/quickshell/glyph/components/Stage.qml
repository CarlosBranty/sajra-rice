import QtQuick
import QtQuick.Window
import qs

// холст в пикселях макета 1920×1080: растянут на родителя, внутри всё меряется как в concept.html
Item {
    // px макета → логические: по монитору, где окно (его 1920×1080). Был Theme.s — по первому экрану, и на 1080p рядом с
    // 2304×1440 всё выходило ×1.2 и не влезало. Бар задаёт свой (Theme.barK). Окна с размером из макета берут stage.k
    property real k: Screen.width > 0 ? Math.min(Screen.width / 1920, Screen.height / 1080) : Theme.s
    width: parent.width / k
    height: parent.height / k
    scale: k
    transformOrigin: Item.TopLeft
}
