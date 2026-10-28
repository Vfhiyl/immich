cmake_minimum_required(VERSION 3.12)

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)

project(native_buffer LANGUAGES C CXX)

add_library(native_buffer SHARED
    src/main/cpp/native_buffer.c
    src/main/cpp/native_image.c
)

target_link_libraries(native_buffer jnigraphics)

# Decoding parts of very large images with our own decoders (native/region), over the static libraries that
# native/build-region.sh builds (the Gradle build runs it, and passes where they are)
set(REGION_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/../../../native/region")
include("${IMMICH_REGION_ROOT}/android-${ANDROID_ABI}/region.cmake")

add_library(immich_region SHARED
    src/main/cpp/region_jni.c
    ${REGION_SOURCE}/immich_region.c
    ${REGION_SOURCE}/heif.c
    ${REGION_SOURCE}/jpeg.c
    ${REGION_SOURCE}/png.c
)

target_include_directories(immich_region PRIVATE ${REGION_SOURCE} ${IMMICH_REGION_INCLUDE})
# only the JNI functions are seen from outside
set_target_properties(immich_region PROPERTIES C_VISIBILITY_PRESET hidden)
# libheif and libde265 are C++: linked with the static C++ library (ANDROID_STL), and their symbols kept inside
set_target_properties(immich_region PROPERTIES LINKER_LANGUAGE CXX)
target_link_libraries(immich_region ${IMMICH_REGION_LIBRARIES} m)
target_link_options(immich_region PRIVATE -Wl,--gc-sections -Wl,--exclude-libs,ALL)
