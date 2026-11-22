cmake_minimum_required(VERSION 3.21)
project(glyph-tok LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Gui Quick Network WebEngineQuick)
qt_standard_project_setup(REQUIRES 6.5)

# ad blocker: Brave's engine (adblock-rust) built by cargo as a static library (adblock/), see adblock.h
set(TOK_ADBLOCK_LIB ${CMAKE_BINARY_DIR}/adblock/release/libtok_adblock.a)
add_custom_command(
    OUTPUT ${TOK_ADBLOCK_LIB}
    COMMAND cargo build --release --lib --manifest-path ${CMAKE_SOURCE_DIR}/adblock/Cargo.toml
            --target-dir ${CMAKE_BINARY_DIR}/adblock
    DEPENDS ${CMAKE_SOURCE_DIR}/adblock/src/lib.rs ${CMAKE_SOURCE_DIR}/adblock/Cargo.toml
    COMMENT "Building tok_adblock (adblock-rust)"
    VERBATIM USES_TERMINAL)
add_custom_target(tok_adblock_build DEPENDS ${TOK_ADBLOCK_LIB})
add_library(tok_adblock STATIC IMPORTED)
set_target_properties(tok_adblock PROPERTIES IMPORTED_LOCATION ${TOK_ADBLOCK_LIB})
add_dependencies(tok_adblock tok_adblock_build)

qt_add_executable(glyph-tok main.cpp adblock.cpp adblock.h)
# antes de qt_add_qml_module: si va después, el qmldir sale sin "singleton Theme" y Theme.* queda undefined
set_source_files_properties(qml/Theme.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)
qt_add_qml_module(glyph-tok
    URI tok
    VERSION 1.0
    QML_FILES qml/Main.qml qml/Btn.qml qml/Theme.qml qml/Dm.qml
    RESOURCES qml/inject.js qml/shaders/dots.frag.qsb
)

target_link_libraries(glyph-tok PRIVATE Qt6::Gui Qt6::Quick Qt6::Network Qt6::WebEngineQuick tok_adblock dl m pthread)

install(TARGETS glyph-tok RUNTIME DESTINATION bin)
# lists + scriptlets for the ad blocker: glyph-tok-adblock-update (uses ubo-resources.py from libexec)
install(PROGRAMS tools/glyph-tok-adblock-update DESTINATION bin)
install(FILES tools/ubo-resources.py DESTINATION libexec/glyph-tok)
