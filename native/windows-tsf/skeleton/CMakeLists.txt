cmake_minimum_required(VERSION 3.20)
project(LekhTextService LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "LekhTextService is a Windows TSF DLL and must be built on Windows with MSVC.")
endif()

add_library(LekhTsfProtocol STATIC
  TsfProtocol.cpp
)

add_library(LekhPipeSecurity STATIC
  LekhPipeSecurity.cpp
)

target_compile_features(LekhTsfProtocol PUBLIC cxx_std_20)
target_include_directories(LekhTsfProtocol PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_features(LekhPipeSecurity PUBLIC cxx_std_20)
target_compile_definitions(LekhPipeSecurity PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
target_include_directories(LekhPipeSecurity PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(LekhPipeSecurity PRIVATE advapi32)

add_library(LekhTextService SHARED
  ClassFactory.cpp
  DllMain.cpp
  InputScopeGuids.cpp
  IpcClient.cpp
  LekhTextService.cpp
  Register.cpp
  TsfEditSession.cpp
)

target_compile_features(LekhTextService PRIVATE cxx_std_20)
target_compile_definitions(LekhTextService PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
target_include_directories(LekhTextService PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(LekhTextService PRIVATE
  LekhTsfProtocol
  ole32
  oleaut32
  uuid
  advapi32
  shlwapi
)

if(MSVC)
  target_compile_options(LekhTsfProtocol PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  target_compile_options(LekhPipeSecurity PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  target_compile_options(LekhTextService PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
endif()

set_target_properties(LekhTextService PROPERTIES
  OUTPUT_NAME "LekhTextService"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib"
)

include(CTest)
if(BUILD_TESTING)
  add_executable(LekhTsfProtocolTests TsfProtocolTests.cpp)
  target_link_libraries(LekhTsfProtocolTests PRIVATE LekhTsfProtocol)
  if(MSVC)
    target_compile_options(LekhTsfProtocolTests PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  endif()
  add_test(NAME LekhTsfProtocolTests COMMAND LekhTsfProtocolTests)

  add_executable(LekhPipeSecurityTests LekhPipeSecurityTests.cpp)
  target_compile_definitions(LekhPipeSecurityTests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _WIN32_WINNT=0x0A00
  )
  target_link_libraries(LekhPipeSecurityTests PRIVATE LekhPipeSecurity advapi32)
  if(MSVC)
    target_compile_options(LekhPipeSecurityTests PRIVATE /W4 /WX /permissive- /utf-8 /sdl)
  endif()
  add_test(NAME LekhPipeSecurityTests COMMAND LekhPipeSecurityTests)
endif()
