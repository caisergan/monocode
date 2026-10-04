Pod::Spec.new do |s|
  s.name           = 'MonoTranscript'
  s.version        = '0.1.0'
  s.summary        = 'MonoCode native transcript view'
  s.description    = 'Measures transcript rows off the main thread with CoreText and paints them from recycled layers.'
  s.license        = 'MIT'
  s.author         = 'MonoCode'
  s.homepage       = 'https://github.com/caisergan/monocode'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
